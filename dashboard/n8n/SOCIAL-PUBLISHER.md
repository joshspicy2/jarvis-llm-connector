# Social publisher (Facebook and Instagram, approval-gated)

File: `social-publisher-workflow.json`. Publishes **only** Approvals rows a human has set to `Approved`. As shipped it cannot post anything.

## End to end
1. A draft is requested: `POST /webhook/jarvis/marketing` with `{channel: "facebook"|"instagram", topic, notes?, image_url?}` (Marketer, drafts only), or in the dashboard chat type `/post facebook <topic>` or `/post instagram <topic>` (calls the same webhook). Claude sessions use the same webhook, so chat and Claude feed one queue.
2. The draft lands in Approvals as *Awaiting Approval*, `Type = Content`, and QA checks it. The Draft text starts with `Channel: facebook|instagram` and, if given, an `Image: https://...` line.
3. Makenzie or Joshua edits if needed, sets Status `Approved`, and sets `Decided By` and `Decided At` (with a time).
4. This workflow (every 10 minutes) re-validates each Approved row, and only then calls the Graph API. A confirmed post sets Status `Sent` and logs it.

## Safe-by-default layers
- `active: false` on import.
- `DRY_RUN = true` in `Select social posts`: rows are only logged as "would publish"; nothing is called or set to Sent.
- Every Graph node (`Publish Facebook`, `Create Instagram media`, `Publish Instagram media`) ships `disabled: true`.
- A row is skipped if: not Approved, not Content, QA Fail without `Decided By`, `Decided At` missing, edited more than 5 minutes after `Decided At`, flagged `NEEDS HUMAN`, no Body, or Instagram without an image URL. Max 3 posts per run.
- "Sent" is written only when Graph returns a new id (`Confirm publish result`). A failure leaves the row Approved and logs an Error.
- `Send` (the generic send step) skips `Channel: facebook|instagram` drafts so the two workflows never both act on a post.

## Joshua's setup (you type every login; nothing goes in the repo)
1. Instagram account is Business or Creator and linked to the High Tide Wash Facebook Page.
2. developers.facebook.com: create an app (type Business), add Instagram API and Facebook Login for Business. Permissions: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish`. Development mode is enough while you administer the accounts.
3. In Graph API Explorer generate a long-lived Page access token. In n8n create a credential: Header Auth, Name `Authorization`, Value `Bearer <token>`; select it on the three Graph nodes.
4. Replace `REPLACE_WITH_FACEBOOK_PAGE_ID` and `REPLACE_WITH_INSTAGRAM_ACCOUNT_ID` in `Build Graph requests`; set `REPLACE_WITH_N8N_BASE` on the chat node `Draft social post`; enable the Marketer webhook (see `MARKETER.md`).
5. Test with one harmless post: Approve it, leave `DRY_RUN = true` for a day and read the Activity Log, then set `DRY_RUN = false` and enable the three Graph nodes. To stop at any time, deactivate the workflow.

## Limits
- Instagram cannot post text only; it needs a public https image. Use your own photos, never client photos or before/afters.
- Instagram media create then publish is two calls; enable both Instagram nodes together.
- Graph API parameters and the pinned version (`v21.0`) are unverified against a live app; check the first execution.
- Searching other people's posts is not offered by the Graph API without Meta App Review; this workflow does not search.
- Tests: `node --test tests/n8n/social_publisher.test.js`.
