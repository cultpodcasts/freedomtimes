/**
 * Build the X post for one article and print the text and intent link.
 * Always dry-run: it does not email and does not call X.
 *
 *   npx tsx scripts/x-auto-dry-run.mts --title "Headline" --hook "One sentence." --slug my-article
 */
import { handleXAutoPublish } from '../src/lib/x-auto/run.ts';
import type { ShareKv } from '../src/lib/social-share/panel.ts';

function arg(name: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value || value.startsWith('--')) {
		throw new Error(`Missing --${name}`);
	}
	return value;
}

const kv: ShareKv = {
	async getVersioned() {
		return null;
	},
	async compareAndSet() {
		return { applied: true, revision: '1' };
	},
	async compareAndDelete() {
		return { applied: true };
	},
	async set() {},
};

const title = arg('title');
const hook = arg('hook');
const slug = arg('slug');
const result = await handleXAutoPublish(
	{
		id: slug,
		slug,
		status: 'published',
		data: { title, lede: hook },
	},
	'posts',
	{
		env: { SITE_ACCESS_MODE: 'locked', X_AUTO_POST_MODE: 'api', X_AUTO_POST_ALLOW_SEND: 'yes' },
		kv,
		now: () => new Date(),
		sendEmail: async () => {
			throw new Error('dry-run script must not email');
		},
		fetch: async () => {
			throw new Error('dry-run script must not call X');
		},
		log: () => {},
	},
);

if (result.action !== 'dry-run' || !result.draft) {
	throw new Error(`Expected a dry run, got ${result.action} ${result.reason ?? ''}`);
}

console.log(JSON.stringify({
	action: result.action,
	weightedLength: result.draft.weightedLength,
	text: result.draft.text,
	intentUrl: result.draft.intentUrl,
	articleUrl: result.draft.url,
}, null, 2));
