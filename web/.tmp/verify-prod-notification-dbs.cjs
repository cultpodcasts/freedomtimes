const { createClient } = require("@libsql/client");

async function count(url, token, sql) {
  const db = createClient({ url, authToken: token });
  const res = await db.execute(sql);
  db.close();
  return res.rows[0]?.c ?? 0;
}

async function main() {
  const subsUrl = process.env.SUBS_URL;
  const subsToken = process.env.SUBS_TOKEN;
  const schedUrl = process.env.SCHED_URL;
  const schedToken = process.env.SCHED_TOKEN;

  const pushCount = await count(subsUrl, subsToken, "select count(*) as c from push_subscriptions");
  const jobCount = await count(schedUrl, schedToken, "select count(*) as c from scheduler_jobs");

  console.log(JSON.stringify({ pushSubscriptionsRows: pushCount, schedulerJobsRows: jobCount }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
