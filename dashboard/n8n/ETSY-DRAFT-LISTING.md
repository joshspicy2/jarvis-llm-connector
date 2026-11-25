# Jarvis Etsy Draft Listing workflow

`etsy-draft-listing-workflow.json` creates an Etsy **draft** digital-download listing, uploads its photos and files, and stops.
It never publishes. State is forced to `draft` in the `Validate Draft` Code node, and no node can set a listing active.
A human reviews the draft in Etsy (Shop Manager -> Listings -> Drafts) and presses Publish.
Not imported into a live n8n and not run against Etsy; validate with `python3 scripts/validate_workflows.py dashboard/n8n/etsy-draft-listing-workflow.json`.

## Endpoint: `POST /webhook/jarvis/etsy/draft-listing`
Auth: n8n Header Auth credential on the webhook (same style as the Etsy Orders workflow). Example body:

```json
{
  "title": "Baby Shower Prediction Cards Printable, Boy or Girl ...",
  "description": "Plain text, max 20000 chars",
  "price": 5.99,
  "quantity": 999,
  "taxonomy_id": 0,
  "tags": ["baby shower game", "gender guess game"],
  "images": [ { "url": "https://.../mockup-1.jpg" } ],
  "files":  [ { "url": "https://.../Lavender_Sage_BoyGirl.pdf", "name": "Lavender Sage.pdf" } ]
}
```

Response: `{ ok, state: "draft", listing_id, title, uploads: { images, files, failed }, edit_path, note }`. Bad input gets HTTP 400 `{ ok:false, error }`.

Limits enforced: title 140, up to 13 unique tags of 20 characters or fewer (lowercased), up to 5 files and 20 images, every url https, price between 0 and 10000, quantity 1 to 999. `taxonomy_id` is required (find the digital Party Games id in Etsy, or via the Etsy taxonomy endpoint); it is not guessed here.

## Flow
Webhook -> Validate Draft -> Draft valid? (else 400) -> Create Draft Listing (Etsy `createDraftListing`, `type=download`, `state=draft`) -> Prep Uploads (one item per image/file) -> Is image? / Is file? -> Fetch (binary GET of the https url) -> Upload Image / Upload File (multipart to `.../listings/{id}/images` and `.../files`) -> Merge Uploads -> Collect Results -> Log Draft Run (Agent Activity Log, Agent `Etsy`) -> Respond.
Upload failures do not stop the run: the draft still exists, and `uploads.failed` says how many did not attach.

## Needs before it works (not done here)
1. **Etsy write access.** Etsy is connected read-only today. Re-authorize the Etsy OAuth app with scopes `listings_r` and `listings_w` (and keep `shops_r`), in the n8n UI only. Create an n8n OAuth2 credential and select it on the three Etsy HTTP nodes. No credential or token is in this repo.
2. **API key header.** The three Etsy HTTP nodes carry an `x-api-key` header with the placeholder `REPLACE_WITH_ETSY_KEYSTRING_COLON_SHARED_SECRET`. Type `keystring:shared_secret` into the node in n8n (as with the Etsy poller). Never commit it.
3. Replace `REPLACE_WITH_ETSY_SHOP_ID` in the three Etsy URLs with the numeric shop id.
4. Select the Header Auth credential on the webhook, and the Notion credential on `Log Draft Run`. Replace the `allowedOrigins` placeholder (never `*`).
5. Cloudflare Access: calls from the dashboard are covered; a service caller needs its own policy.
6. The asset urls must be reachable by n8n over https (for example an object store link with a short expiry). Files are not stored in this repo.

## Known gaps
- Color or design choices are not created as Etsy variations. Put all colorways in the download as separate files, or add variations in Etsy by hand.
- Shipping profile and return policy are not set (not needed for digital).
- Etsy parameter details (form encoding of `tags`, multipart field names) are from the public API docs and unverified against a live shop. Expect to adjust on the first execution.
- The Notion Activity Log database id is the same one the other Etsy workflows use, and `Etsy` must exist as an Agent option there.
