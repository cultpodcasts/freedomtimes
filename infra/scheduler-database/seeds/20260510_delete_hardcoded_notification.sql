-- Seed: Remove the old hardcoded notification job
DELETE FROM scheduler_jobs WHERE id = 'hardcoded-notification-every-10-minutes';
