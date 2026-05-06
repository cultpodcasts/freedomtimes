import { createClient } from "@libsql/client";

async function main() {
  const url = "libsql://freedomtimes-emdash-staging-freedomtimes.aws-eu-west-1.turso.io";
  const authToken = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3NzU5MzY5ODEsImlkIjoiMDE5ZDdlMTctYzQwMS03ZWMzLWEzOWEtMGIxN2VmOGZhNmFjIiwicmlkIjoiNTMyMzdhYTctOGM1ZC00N2M5LWJlN2EtYjQzZTJkZWY3ZGMwIn0.VjuLoUKYjhrH9AStZ5l-drIbwmuO9tO7eqo4Vwo1PfCe7ZJxHdaiJoREnor3C_jwuEbHq64RRgE2l2Fae-sFCg";

  const db = createClient({ url, authToken });
  const result = await db.execute("delete from options where name = 'emdash:manifest_cache'");
  console.log("Cache cleared", result);
}

main().catch(console.error);
