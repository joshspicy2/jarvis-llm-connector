# Billing, autopay and contracts (design draft)

Status: DRAFT for Joshua's review. Nothing here is applied to production. Replaces the QuoteIQ estimates/invoices/contracts role.

## Goal

Low cost (target: no monthly software fee), we get paid, recurring clients autocharged per visit (no Stripe Subscriptions), and true e-signed contracts. Jarvis (n8n + Notion) is the glue. Notion stays the source of truth; Stripe is already in use.

## Parts

| Job | Tool | Cost |
|---|---|---|
| Pricing, estimate drafts, clients, status | Notion + Estimate agent | $0 |
| Saved payment methods, per-visit invoices, card/bank payments | Stripe (Invoicing, Customer Portal) | Stripe processing fees plus a small Billing fee on recurring volume (verify current rates) |
| E-signed contracts | One of: Documenso (open source, self-hostable), Square free contracts (signing only), or a paid e-sign tool | $0 to verify; see "E-sign options" |
| Glue and approvals | n8n at `ops.hightidewash.net`, Approvals database | $0 |
| Public terms pages | hightidewash.net | $0 |

## Flow

1. Intake/Router creates or updates the client in Notion (Clients DB).
2. Estimate agent drafts the estimate from Estimate Rules. It lands in Approvals as *Awaiting Approval*. Makenzie approves (nothing client-facing is sent without human approval).
3. On approval, n8n picks the matching terms template (see below), fills the client fields and sends it for e-signature.
4. E-sign webhook (signed) reaches n8n. n8n stores the signed PDF link and date on the client's Notion page, then creates the Stripe customer and saves the payment method (setup with autopay consent for recurring clients). Each completed visit then produces a Stripe invoice, charged automatically for recurring clients and sent as a pay link for standard and deep clean.
5. Stripe webhooks (`invoice.paid`, `invoice.payment_failed`, `payment_method.detached`) post to n8n. Router classifies; failed payments are IMPORTANT, and War Mode rules still apply. Matching into Notion uses the existing Stripe to Notion invoice matching.
6. Every run is written to the Agent Activity Log.

Human gates: estimate approval (Makenzie), the contract send, and any dunning message to a client. Joshua approves production changes.

## Contract/terms templates

Joshua's terms sets: deep clean, monthly, bi-weekly, weekly, and standard (the one-time "regular" clean). A signed contract is required for every client. The three recurring contracts (weekly, bi-weekly, monthly) include explicit autopay consent, so clients know the card or bank account is charged automatically each visit.

Each template has a stable id and a version, kept in the repo so changes are reviewed:

| Template id | Billing shape in Stripe |
|---|---|
| `deep-clean` | One-time invoice, paid before or at service |
| `standard` | One-time invoice per visit, paid at or after service (no autopay clause) |
| `weekly` | Charged per visit, autopay consent in contract |
| `bi-weekly` | Charged per visit, autopay consent in contract |
| `monthly` | Charged per visit, autopay consent in contract |

Template text is not drafted here. Makenzie/Joshua supply the existing wording; do not invent legal terms.

## Using hightidewash.net

Yes, usefully:

- **Public terms pages**: `REPLACE_WITH_SITE_ORIGIN/terms/<template-id>` so the signed contract can link to the exact version. Static pages, versioned.
- **Self-hosted e-sign** (only if Documenso passes the checks below): a subdomain on the Oracle VM behind Caddy, same pattern as n8n, for example `REPLACE_WITH_SIGN_DOMAIN`.
- **Client billing links**: Stripe Customer Portal for cancel/update card. A branded Stripe domain may cost extra; verify before relying on it.
- Webhook endpoints must stay on `ops.hightidewash.net` with specific origins; never `allowedOrigins: *`.

## E-sign options to verify (not yet checked)

- **Documenso**: confirm free self-host terms, ARM64 image for the Oracle VM, API/webhooks for "document signed", and that it returns a signed PDF with audit trail.
- **Square contracts**: free e-sign confirmed on Square's pricing page, but it is tied to Square customers; check whether n8n can trigger it (the public API docs did not list contracts).
- Whatever is chosen: confirm it meets the ESIGN Act / Florida UETA basics (consent, audit trail, copy to signer). Have Joshua decide if a lawyer should review the templates.

## Open questions

Answered by Joshua: "regular" = standard clean; recurring clients are billed per visit; every client signs a contract; recurring contracts include autopay consent.

Decided by Joshua: no Stripe Subscriptions. Every visit is charged automatically to the saved payment method, even when a visit is rescheduled, so clients never have to pull out a card. The charge follows the visit, not a billing calendar.

1. Who triggers each charge: job marked complete in Notion, approved by a human? (Recommended; keeps a human gate on money movement.)
2. Cancellation and skipped-visit rules (affects Stripe proration and pause settings).
3. Stripe Invoices/Clients property names in Notion are not verified (`docs/NOTION-SCHEMA.md`); check before building any workflow.

## Out of scope

No credentials, no n8n workflow JSON, no Notion property changes in this draft. Workflows follow after approval, in `dashboard/n8n/` with a sibling `.md`.
