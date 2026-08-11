import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const posts = (await getCollection('blog'))
    .filter((post) => !post.data.draft)
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());

  return rss({
    title: 'Blog — Lucas Rodrigues Bordignon',
    description:
      'Artigos sobre desenvolvimento de software, arquitetura de sistemas e cloud.',
    site: context.site!,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      link: `blog/${post.id.replace(/\.(md|mdx)$/i, '')}/`,
    })),
    customData: '<language>pt-br</language>',
  });
}
