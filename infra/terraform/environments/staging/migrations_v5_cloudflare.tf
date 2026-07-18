# One-shot v4→v5 Cloudflare provider migration. Remove this file after a successful
# staging apply that imports the Workers custom domain (and drops removed secrets/domain
# from state without destroying them in Cloudflare).
#
# Import ID format: <account_id>/<domain_id> (see cloudflare_workers_custom_domain docs).

import {
  to = module.cloudflare_holding_page.cloudflare_workers_custom_domain.holding_page[0]
  id = "bae3f835f19899c6eee1ec48f2d658cf/6f4874629a04c9207f84669f85ede502f723f288"
}
