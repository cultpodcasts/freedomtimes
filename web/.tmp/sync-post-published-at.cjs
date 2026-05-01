const { createClient } = require("@libsql/client");

async function main() {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  const updates = [
    {
      slug: "ahmadi-religion-of-peace-and-light-crewe-raids-roundup-30-apr-2026",
      publishedAt: "2026-04-30T15:49:24.869Z",
    },
    {
      slug: "pbcc-plymouth-brethren-cult-in-plain-sight-what-unchosen-shows-us-about-hidden-c-1",
      publishedAt: "2026-04-29T14:21:01.549Z",
    },
    {
      slug: "introducing-freedom-times-uk-europe-survivor-advocacy",
      publishedAt: "2026-04-11T20:45:49.768Z",
    },
  ];

  for (const item of updates) {
    await db.execute({
      sql: "update ec_posts set published_at = ? where slug = ?",
      args: [item.publishedAt, item.slug],
    });
  }

  const check = await db.execute(
    "select slug, published_at from ec_posts where slug in (?, ?, ?) order by published_at desc",
    updates.map((u) => u.slug),
  );
  console.log(JSON.stringify(check.rows, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
