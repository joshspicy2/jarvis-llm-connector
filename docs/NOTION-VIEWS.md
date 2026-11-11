# Notion Views: Approvals and Pipeline

Click-by-click setup for the five Approvals views specified in `NOTION-SCHEMA.md` section 3 ("Pages and views"), plus a
suggested Pipeline board. This doc only describes how to build them; the schema doc stays the source for what they
are. Do not rename any property or select option while doing this: the n8n workflows match them literally.

Notion's menus move around, so labels below are the current ones (2026) and may differ slightly. Views are
presentation only; none of this changes data or affects the workflows.

## 0. Before you start
1. Open the **Approvals** database (under the Jarvis hub page). Use the full-page database, not an inline copy.
2. Share the database with the n8n Notion integration (`...` menu at top right, **Connections**, add the integration).
   Not needed for views, but the Approvals API cannot read it otherwise.
3. Notion creates a first view called "Table" by default. You will rename it to **Needs Approval** in step 1.

How to add a view (used for each one below): at the top of the database, click **+** next to the existing view tabs
(**Add a view**), pick the layout, type the name, click **Create**. Then for each view:
- **Filter**: click `...` (or the view's filter icon) > **Filter** > **Add filter** (or **Add a filter**), choose the
  property, the condition, and the value.
- **Sort**: **Sort** > **Add sort**, choose the property and direction.
- **Properties**: `...` > **Properties**. Toggle the eye icon so only the listed ones are visible. Title is always shown.
- **Group**: `...` > **Group**, choose the property.

## 1. Needs Approval (default, Makenzie's daily queue)
1. Click the existing **Table** view tab, then `...` > **Rename**, set the name to `Needs Approval`.
2. Layout stays **Table**.
3. **Filter** > Add filter > `Status` > `Is` > `Awaiting Approval`.
4. **Sort** > Add sort > `Created` > `Ascending` (oldest first).
5. **Properties**: show `Title`, `Agent`, `Type`, `QA Result`, `Related Job`. Hide `Draft`, `Created`, `Decided By`,
   `Decided At` (Status is hidden too; the filter makes it redundant, but show it if you like).
6. Make it the default: drag the tab to the first position (the first tab opens by default).
7. Pin: open the Jarvis home page, type `/linked`, choose **Create linked view of database**, pick Approvals, then
   choose the **Needs Approval** view. Or: in the view tab `...` menu, **Copy link to view**, and paste it on the home page.

## 2. Ready to Send
1. **+** > **Table** > name `Ready to Send` > **Create**.
2. **Filter** > Add filter > `Status` > `Is` > `Approved`.
3. **Sort** > Add sort > `Decided At` > `Ascending` (longest waiting first).
4. **Properties**: show `Title`, `Agent`, `Type`, `Related Job`, `Decided By`, `Decided At`.
5. Use: Sent is manual today (open question 1 in the schema doc). After the content actually goes out, set
   `Status` to `Sent` on the row.

## 3. QA Failed
1. **+** > **Table** > name `QA Failed` > **Create**.
2. **Filter** > Add filter > `Status` > `Is` > `Awaiting Approval`.
3. Add a second filter (same filter group, joined by **And**) > `QA Result` > `Is` > `Fail`.
4. **Sort** > Add sort > `Created` > `Ascending`.
5. **Properties**: show `Title`, `Agent`, `Type`, `QA Result`, `Related Job`, `Created`.
6. A Fail row should not be approved without a reason in the page body (schema rule 2).

## 4. History
1. **+** > **Table** > name `History` > **Create**.
2. **Filter** > Add filter > `Status` > `Is` > `Sent`. Click **+ Add filter** inside the same group, choose `Status` >
   `Is` > `Rejected`, then change the join word from **And** to **Or**. (Alternative: one filter `Status` > `Is
   not` > `Awaiting Approval`, then a second `Status` > `Is not` > `Approved`, joined by And. Same result.)
3. **Group** > `Type`. Leave group order as is; optionally hide empty groups.
4. **Sort** > Add sort > `Created` > `Descending` (newest first). `Created` is the only always-filled date; `Decided At`
   is optional and may be empty.
5. **Properties**: show `Title`, `Agent`, `Status`, `QA Result`, `Decided By`, `Decided At`, `Created`.

## 5. By Agent (Joshua's agent quality review)
1. **+** > **Board** > name `By Agent` > **Create**.
2. **Group** > `Status` (columns: Awaiting Approval, Approved, Rejected, Sent). Show all columns, including empty ones.
3. **Sub-group** (optional, `...` > **Sub-group**) > `Agent`, so each agent gets its own swimlane. This is what makes
   the view "by agent".
4. No filter. **Sort** > `Created` > `Descending`.
5. **Card properties** (`...` > **Properties**): show `Agent`, `Type`, `QA Result`, `Created`. Set **Card preview** to
   `None`.
6. Dragging cards between columns edits `Status`. That is a human-only action (schema rule 1), so use this view to
   read, not to approve.

## 6. Type templates (optional, from the schema doc)
In the database, click the arrow next to **New** > **+ New template**, one per Type, so Draft bodies stay consistent:
Estimate (line items, assumptions, total, Estimate Rules rows used), Reply (recipient, channel), Content (channel,
timing). Set `Type` and `Status = Awaiting Approval`, `QA Result = Not checked` as template defaults.

## 7. Suggested Pipeline board (not in the schema doc)
This is a suggestion; Pipeline is also read by the Dashboard API and Conductor, and views do not affect them.
1. Open the **Pipeline** database. **+** > **Board** > name `Jobs by Status` > **Create**.
2. **Group** > `Status`. Columns in this order (drag to reorder): Booked, In Progress, Awaiting Invoice, Paid, Flagged.
   Do not add or rename options.
3. **Sort** > `Scheduled Date` > `Ascending`.
4. **Card properties**: show `Job Type`, `Assigned To`, `Scheduled Date`, `Flag Reason`. Hide `Notes`, `Client`, `Invoice`.
5. Optional filter to keep the board short: `Status` > `Is not` > `Paid`. Add a separate table view `Paid` with
   `Status` > `Is` > `Paid` for the archive, since Paid is terminal for the dashboard UI.
6. Moving a card between columns writes `Status`, same as the dashboard's pipeline-move endpoint
   (`dashboard/n8n/PIPELINE-MOVE.md`); either is fine for humans.

## 8. Check
- Create a test row in Approvals with `Status = Awaiting Approval`: it appears in Needs Approval only. Set
  `QA Result = Fail`: it also appears in QA Failed. Set `Status = Approved`: it moves to Ready to Send. Set `Sent`: it
  appears in History. Delete the test row afterwards.
