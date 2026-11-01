/**
 * Build the X and Bluesky posts for one article and print the text and intent links.
 * Always dry-run: it does not call either network.
 *
 *   npx tsx scripts/x-auto-dry-run.mts --title "Headline" --slug my-article
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
const slug = arg('slug');
const result = await handleXAutoPublish(
	{
		id: slug,
		slug,
		status: 'published',
		data: { title },
	},
	'posts',
	{
		env: { SITE_ACCESS_MODE: 'locked', X_AUTO_POST_MODE: 'api', X_AUTO_POST_ALLOW_SEND: 'yes' },
		kv,
		now: () => new Date(),
		fetch: async () => {
			throw new Error('dry-run script must not call a network');
		},
		log: () => {},
	},
);

if (result.action !== 'dry-run' || result.networks.length !== 2) {
	throw new Error(`Expected a dry run of both networks, got ${result.action} ${result.reason ?? ''}`);
}

console.log(JSON.stringify({
	action: result.action,
	networks: result.networks.map((network) => ({
		network: network.network,
		text: network.text,
		intentUrl: network.intentUrl,
	})),
}, null, 2));
