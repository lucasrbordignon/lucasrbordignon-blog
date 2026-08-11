---
title: "Arquitetura: App Offline-First com React Native, Fastify e Drizzle ORM"
description: "Um mergulho técnico no desenho arquitetural de um app resiliente de alta disponibilidade, com fila de mutações local, orquestração de conexões e resolução de conflitos por tempo."
date: 2026-08-11
draft: false
---

Construir aplicativos que dependem de conexão contínua com a internet para todas as ações do usuário é uma receita para frustração. Em cenários reais — como uso em trânsito, elevadores, galpões logísticos ou simplesmente redes móveis instáveis —, as requisições falham e a experiência de uso é severamente comprometida. 

A abordagem **Offline-First** inverte essa dinâmica: a interface do usuário lê e escreve exclusivamente em um banco de dados local presente no dispositivo móvel. Toda e qualquer sincronização com a infraestrutura de backend ocorre em segundo plano, de forma assíncrona, robusta e resiliente.

Neste artigo, detalho a engenharia por trás de uma solução offline-first projetada para sistemas corporativos de missão crítica.

---

### Ficha Técnica do Sistema
*   **Mobile:** React Native | Drizzle ORM + SQLite (persistência relacional local) | MMKV (armazenamento key-value rápido para tokens e timestamps) | Zustand (gerenciamento de estado leve e reativo)
*   **Backend:** Fastify | PostgreSQL (consistência relacional centralizada)
*   **Padrões:** Clean Architecture + MVVM + Resolução de conflitos baseada em tempo (*Last Write Wins* - LWW)

---

## 1. Arquitetura Geral do Sistema

A chave de um aplicativo offline-first confiável é o **desacoplamento total** entre a camada visual (UI) e os serviços de transporte de rede. O fluxo principal é síncrono e imediato sobre o banco local, enquanto um serviço autônomo gerencia a sincronização assíncrona com o backend.

```mermaid
graph TD
    subgraph Client_Mobile [React Native Application - Offline First]
        UI[React Native UI Components] -->|Observa / Interage| VM[ViewModels]
        VM -->|Executa| CA[Clean Architecture Layers]
        CA <-->|Leitura/Escrita Principal| LocalDB[(SQLite + Drizzle ORM)]
        CA -->|Tokens / Session| KeyValue[(MMKV Cache)]
        
        Sync[Sync Service] <-->|Consome Fila / Atualiza Tabelas| LocalDB
        Sync -->|Lê LastSyncAt| KeyValue
    end

    subgraph Network_Transport [Camada de Transporte]
        Sync <-->|HTTPS REST / JSON| API_Gateway[Fastify Backend API]
        Sync -.->|Futuro: WebSockets Notificações| API_Gateway
    end

    subgraph Backend_Infrastructure [Infraestrutura Remota]
        API_Gateway -->|Regras / Jobs| Services[Services & Background Jobs]
        Services <-->|Persistência Oficial| RemoteDB[(PostgreSQL)]
        Services <-->|Sistemas de Terceiros| External[Sistemas Externos]
    end

    style Client_Mobile fill:#f9f,stroke:#333,stroke-width:2px
    style Backend_Infrastructure fill:#bbf,stroke:#333,stroke-width:2px
```

### Componentes-Chave no Dispositivo Móvel:
-   **SQLite + Drizzle ORM:** Persistência relacional de alto desempenho com suporte a type safety. Toda leitura de tela vem diretamente do SQLite.
-   **MMKV Cache:** Storage chave-valor ultrarrápido rodando nativamente via JSI (JavaScript Interface), ideal para armazenar metadados críticos como o token de autenticação e o cursor da última sincronização bem-sucedida (`lastSyncAt`).
-   **Sync Service:** Thread/Serviço encarregado de processar a fila local de alterações pendentes de envio (Push) e baixar as atualizações do servidor (Pull).

---

## 2. Estrutura Clean Architecture + MVVM

Para garantir que o código do aplicativo seja testável e escalável, dividimos o app em camadas bem definidas. A interface gráfica não se comunica diretamente com a camada de infraestrutura de dados ou de rede.

```mermaid
graph TD
    subgraph Presentation_Layer [Presentation Layer]
        Screen[React Native Screen / View] -->|Invocações de UI / Data Binding| VM[ViewModel - Zustand State]
    end

    subgraph Domain_Layer [Domain Layer]
        VM -->|Dispara Execução| UC[UseCase / Interactor]
        UC -->|Chama Abstração| RepoInterface[Repository Interface / Contract]
    end

    subgraph Data_Layer [Data Layer]
        RepoInterface -->|Implementação Real| RepoImpl[Repository Implementation]
    end

    subgraph Infrastructure_Layer [Infrastructure Layer]
        RepoImpl -->|Queries / Mutations| Drizzle[Drizzle ORM / SQLite]
        RepoImpl -->|Chamadas HTTP| API[API Client - Axios/Fetch/React Query]
    end

    classDef presentation fill:#e1f5fe,stroke:#01579b;
    classDef domain fill:#e8f5e9,stroke:#1b5e20;
    classDef data fill:#fff3e0,stroke:#e65100;
    classDef infra fill:#f3e5f5,stroke:#4a148c;

    class Screen,VM presentation;
    class UC,RepoInterface domain;
    class RepoImpl data;
    class Drizzle,API infra;
```

-   **Presentation Layer:** As telas React Native interagem apenas com a ViewModel (gerenciada por stores Zustand). A ViewModel expõe os estados necessários e as ações acionadas pelo usuário.
-   **Domain Layer:** Define as regras de negócio puras (UseCases) e os contratos abstratos de repositório. Essa camada não tem dependência de banco de dados ou de bibliotecas de terceiros.
-   **Data Layer & Infrastructure Layer:** A implementação concreta do repositório interage com o Drizzle ORM para gravar localmente. Quando uma mutação ocorre, a implementação do repositório grava o registro local no banco de dados e adiciona uma operação correspondente à tabela de fila de sincronização (`sync_queue`), marcando-a como pendente.

---

## 3. Fluxo de Sincronização: Push

O processo de **Push** envia os deltas (mutação local) capturados no dispositivo móvel em direção ao backend. Para garantir a confiabilidade sob conexões instáveis, o mecanismo utiliza um loteamento (*batching*) cronológico com garantia de idempotência.

```mermaid
sequenceDiagram
    autonumber
    participant DB as SQLite (sync_queue)
    participant SS as SyncService (Mobile)
    participant API as Fastify Backend
    participant PG as PostgreSQL

    SS->>DB: Busca registros com status 'PENDING'
    DB-->>SS: Retorna lista de mutações organizadas por ordem cronológica
    
    loop Para cada lote (Batch) de mutações
        SS->>DB: Atualiza status para 'PROCESSING'
        SS->>API: POST /sync/push { mutations: [...] }
        
        Note over API,PG: Valida tokens, aplica regras de negócio e executa idempotência
        API->>PG: Aplica inserts/updates/deletes (Transação única)
        PG-->>API: Confirmação de persistência
        
        API-->>SS: HTTP 200 OK { processedIds: [UUIDs...] }
        SS->>DB: Remove registros processados da sync_queue (ou marca como SYNCHRONIZED)
    end
```

### Detalhes de Confiabilidade:
1.  **Ordem Cronológica Estrita:** As operações locais devem ser aplicadas na mesma ordem no backend para evitar inconsistências lógicas (por exemplo, atualizar um registro antes dele ter sido criado).
2.  **Idempotência:** Cada mutação gerada no app carrega uma chave única de idempotência (`mutation_id`). Se a requisição cair antes do app receber a resposta HTTP 200, a próxima tentativa enviará a mesma chave, permitindo que o Fastify ignore gravações duplicadas no PostgreSQL.
3.  **Recuperação de Falhas:** Caso ocorra um erro de rede no meio do processamento, as mutações com status `PROCESSING` são resetadas para `PENDING` para reprocessamento na próxima oportunidade.

---

## 4. Fluxo de Sincronização: Pull

Enquanto o Push envia mutações, o **Pull** consome os deltas remotos de registros gerados por outros usuários ou sistemas externos no PostgreSQL. Ele é incremental, trazendo apenas o que mudou desde a última sincronização.

```mermaid
sequenceDiagram
    autonumber
    participant MMKV as MMKV Storage
    participant SS as SyncService (Mobile)
    participant API as Fastify Backend
    participant PG as PostgreSQL
    participant DB as SQLite

    SS->>MMKV: Recupera valor de 'lastSyncAt'
    MMKV-->>SS: Retorna timestamp (ex: 2026-06-02T08:00:00Z)
    
    SS->>API: GET /sync/pull?since=2026-06-02T08:00:00Z
    
    Note over API,PG: Busca registros onde updated_at > since<br/>e filtra pelo contexto do usuário
    API->>PG: SELECT de deltas
    PG-->>API: Linhas alteradas/criadas/deletadas remotamente
    
    API-->>SS: HTTP 200 OK { changes: [...], serverTimestamp: 2026-06-02T08:53:00Z }
    
    Note over SS,DB: Bulk merge utilizando Upsert no Drizzle ORM
    SS->>DB: Grava alterações no banco local
    SS->>MMKV: Atualiza 'lastSyncAt' = 2026-06-02T08:53:00Z
```

### Pontos Importantes do Pull:
-   **Cursor Incremental (`since`):** O cursor da última sincronização (`lastSyncAt`) é lido do cache rápido do MMKV.
-   **Bulk Upsert Local:** Ao receber os deltas, o app usa as instruções nativas de upsert do SQLite (via Drizzle) para inserir novos registros e atualizar dados modificados, resolvendo potenciais conflitos de chaves primárias.
-   **Consistência de Data do Servidor:** O valor de `lastSyncAt` gravado após o pull sempre vem da propriedade `serverTimestamp` retornada pela resposta HTTP. Isso previne qualquer dessincronização causada por relógios locais de aparelhos desregulados ou fusos horários alterados.

---

## 5. Orquestrador SyncJob

Para evitar que loops paralelos gerem concorrência de leitura e escrita nos arquivos do SQLite, o ciclo de sincronização é governado por um orquestrador centralizado baseado em uma máquina de estados finitos.

```mermaid
stateDiagram-v2
    [*] --> Idle
    
    Idle --> VerificandoCondicoes : App Abriu
    Idle --> VerificandoCondicoes : App Voltou p/ Foreground (AppState)
    Idle --> VerificandoCondicoes : NetInfo detectou Conectividade (Online)
    Idle --> VerificandoCondicoes : Timer Periódico disparado (Cron/Interval)

    state VerificandoCondicoes <<choice>>
    VerificandoCondicoes --> ExecutandoSync : se (isOnline && !isSyncing)
    VerificandoCondicoes --> Idle : se (isOffline || isSyncing)

    state ExecutandoSync {
        [*] --> SetSyncTrue : Definir isSyncing = true
        SetSyncTrue --> ExecutarPush : Inicia Bloco Push
        ExecutarPush --> ExecutarPull : Sucesso no Push
        ExecutarPull --> FinalizarSync : Sucesso no Pull
        
        ExecutarPush --> TratarErro : Falha de Rede / Erro HTTP
        ExecutarPull --> TratarErro : Falha de Rede / Erro HTTP
        
        TratarErro --> AgendarRetry : Incrementa Backoff / Mantém dados na Fila
        AgendarRetry --> SetSyncFalse
        FinalizarSync --> SetSyncFalse
    }

    SetSyncFalse --> Idle : Definir isSyncing = false
```

O `SyncJob` escuta eventos do ciclo de vida da aplicação (através do `AppState` do React Native) e de rede (via `@react-native-community/netinfo`). Caso ocorra uma falha de rede temporária durante o ciclo, um algoritmo com **Exponential Backoff** é acionado para reagendar uma nova tentativa, protegendo a rede do cliente e a infraestrutura de backend de loops infinitos de requisições.

---

## 6. Resolução de Conflitos: Last Write Wins (LWW)

Mutações distribuídas podem acarretar conflitos de concorrência: o que acontece se o Dispositivo A altera um registro localmente no mesmo instante em que o Dispositivo B modifica o mesmo registro conectado à internet?

Adotamos a estratégia de **Last Write Wins (LWW)** baseada no timestamp remoto, garantindo consistência determinística em todo o ecossistema do app.

```mermaid
sequenceDiagram
    autonumber
    participant DispA as Dispositivo A (Offline)
    participant Server as Fastify / Postgres
    participant DispB as Dispositivo B (Online)

    Note over DispA, Server: Registro X inicial possui updated_at = 10:00:00
    
    Note over DispA: Às 10:05, altera Registro X offline.<br/>Local updated_at = 10:05:00
    Note over DispB: Às 10:10, altera Registro X online.<br/>Envia imediatamente para o servidor.
    
    DispB->>Server: Push (Registro X, updated_at = 10:10:00)
    Server->>Server: Compara timestamps (10:10 > 10:00).<br/>Atualiza banco remoto.
    Server-->>DispB: OK
    
    Note over DispA: Dispositivo A recupera conexão às 10:15.<br/>Inicia o ciclo de sincronização.
    DispA->>Server: Push (Registro X, updated_at = 10:05:00)
    
    Note over Server: Servidor compara:<br/>Payload recebido (10:05:00)<br/>Métrica atual no Postgres (10:10:00)
    
    alt Payload recebido é mais antigo (Conflito LWW)
        Server->>Server: Rejeita a alteração do Dispositivo A
        Server-->>DispA: HTTP 200 OK ou 409 (Indica que o Push foi ignorado/resolvido)
    end
    
    Note over DispA: Na sequência do ciclo, o Dispositivo A executa o Pull
    DispA->>Server: Pull(since = ultimo_sync)
    Server-->>DispA: Retorna Versão do Registro X (updated_at = 10:10:00)
    DispA->>DispA: SQLite atualizado com o dado do Dispositivo B.
```

### Análise de Caso Real:
1.  **Dispositivo B altera primeiro na nuvem:** A alteração do Dispositivo B atinge o banco central com o timestamp `10:10:00`.
2.  **Dispositivo A sincroniza depois, mas com dado antigo:** Quando o Dispositivo A envia sua mutação de `10:05:00` (gerada enquanto estava offline), o servidor rejeita a aplicação dessa mutação porque `10:10:00` (PostgreSQL) é posterior a `10:05:00`.
3.  **Soberania do Pull:** No final do ciclo, o Dispositivo A executa o Pull correspondente, recebe a atualização com timestamp `10:10:00` e sobrescreve localmente seu próprio dado defasado.

### Nota sobre Sincronia de Tempo local (NTP):
Para que o LWW seja estritamente justo, os relógios locais dos dispositivos móveis devem estar alinhados com o servidor. Implementamos um mecanismo de compensação (*time offset*) durante a inicialização do app: o cliente faz um ping leve ao backend, calcula a diferença entre o relógio local e o servidor e ajusta o cálculo de data das suas mutações locais, mitigando completamente desvios manuais de relógio efetuados pelos usuários.

---

## Conclusão

Projetar uma arquitetura Offline-First exige cautela redobrada em relação à consistência e persistência de dados. No entanto, o retorno sobre o investimento é claro: uma aplicação extremamente rápida que funciona em qualquer condição climática ou de infraestrutura, resultando em maior produtividade e excelente experiência do usuário.
