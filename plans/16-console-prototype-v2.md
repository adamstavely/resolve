# Plan 16 — Console prototype v2 (case workspace)

Status: implemented, 12 Oct 2026.

Source: the owner's new prototype “Resolve Console (standalone) (2).html”, imported as `design/reference/resolve-console-v2.html`.
It supersedes the earlier console reference wherever the two differ.

## 1. Owner decisions (12 October 2026)

1. **Exact UI, real data where it exists.** Every screen, layout and flow matches the prototype.
   - Data comes from the real APIs where one exists.
   - Regions that need systems Resolve does not have yet render in their exact place with a clear "not connected yet" state, never sample data. These systems are:
     - ServiceNow: cases, parent incidents, comms plan, changes, CMDB ownership and on-call, CSM, knowledge, approvals.
     - Account tools.
     - The tier-escalation workflow.
2. **Inbox for chats, My tickets for tickets** (revised the same day; this replaces the first decision, which merged them).
   - Both use the prototype's list style and open into the same case workspace.
   - The Inbox keeps its status and show filters, unread marks and live monitoring.
   - My tickets uses the previous Tickets icon. It defaults to tickets assigned to you, with unassigned and all-open filters, paging per application, and an explicit load for idle applications.
4. **Tier 1 banners.** Anyone whose application reports them at Tier 1 or higher may create an Everyone banner for that application, without the broadcast role.
   - **Capability:** `broadcast.app`, held by agents.
   - **Server checks:**
     - Selected applications only; "All applications" is not open to them.
     - Tier is re-checked at draft, review, publish and dispatch.
     - They see only their own banners.
   - **Console:** a "Create banner" tool in each application's rail and the case rail opens a banner modal for that application only (write, review, publish), without leaving the workspace.
   - **Fork gap:** QB-ANN-3, since Quackback also needs to accept Tier 1 staff as announcement managers. The mock tenant models it.
3. **Administration stays in the sidebar** below Applications, styled like the prototype nav, and is shown only with permission.

## 2. What the prototype adds, and how it maps

The prototype CSS is the earlier reference plus one appended block. Port that block (`.case`, `.conv`, `.ctx`, `.rail`, `.drawer`, `.inc-*`, `.kn-issue`, `.modal`, `.escq-*`, `.cmd-*` and the rest) verbatim into `apps/console/src/prototype.css`. Also port the earlier blocks' screen rules that were never brought across. The console's WCAG-adjusted tokens stay; text that uses `--ink-faint` is raised to `--ink-3` for contrast.

| Prototype | Real data | Not connected yet |
|---|---|---|
| **Top bar:** incidents button and popover, ⌘K search, theme, bell, avatar | Known issues (Elastic); search over apps, open tickets and chats; avatar menu with availability for chats and sign-out | "Copy customer message" (comms plan) |
| **Side nav:** Home, My tickets (waiting count), Escalations, apps with health dot and tier, collapses in workspaces | All of it, plus the Administration section | Escalation count |
| **Home (launchpad):** hero, app health cards, My tickets panel, Known issues panel, Live activity | Health cards (Elastic plus clearance), my items, known issues, console live activity with verified receipts | Customer message |
| **My tickets:** case rows with channel icon, live dot, subject, id, customer, app, matched issue, priority, waiting, SLA and state | Quackback tickets and chats, matched known issue from issue links | ServiceNow "CASE" sync label is replaced by the app name |
| **Case workspace: tool rail** | Ticket and chat tools: assign or unassign, waiting on customer or snooze, resolve or close with pre-flight, reopen, mark read, capture evidence snapshot | Account tools (reset password, refunds, and so on) |
| **Case workspace: conversation pane** | Crumb, live or email pill, waiting, subject, priority, state, SLA bar; thread with customer, agent, note and system events; composer with Reply and Work note, attachments and receipts; presence and typing | Known-issue message insert (comms plan) |
| **Case workspace: context pane** | Customer header (verified id); tabs: Overview (incident banner, next steps, facts), Systems (what the systems saw, is it us, log patterns), Activity (merged timeline), evidence snapshot | Changes tab (What changed, Ownership), Customer context (CSM), Suggested knowledge, escalation banner |
| **Tool drawer:** pre-flight, run, verified downstream confirmation and receipt | Pre-flight API, operation receipts, receipt watcher | Locked-tool escalation (needs the escalation workflow) |
| **Link incident modal:** bulk-link matching tickets | Candidates are open tickets in the issue's app; the match comes from the customer's errors in the issue window; links use the existing per-ticket link API | Approved customer message and the "send" half |
| **App workspace:** rail, header, Overview, Changes and Activity tabs, account inspector, right column | Overview facts, incident banner, SLO and service table, recent actions (audit), your open tickets, "What was checked" | Changes, Ownership, "Find an account" and the account inspector |
| **Escalation queue and detail** | Header, stats and filters in place | Whole queue (no escalation workflow yet); the evidence page uses the detail's evidence-snapshot and draft-summary layout |
| **Command palette** | Apps, open tickets and chats, pages | Accounts and tools |
| **Toasts** | Action results (polite live region) | — |

## 3. Work packages (one commit each)
1. **P1:** reference import, CSS port, shell (top bar, nav, mini nav, toasts, command palette, incidents popover).
2. **P2:** home launchpad.
3. **P3:** My tickets list and redirects.
4. **P4:** case workspace for tickets and chats: rail, conversation pane, context tabs, tool drawer with pre-flight and receipts.
5. **P5:** app workspace, escalations, bulk link modal, evidence page restyle.
6. **P6:** browser tests updated to the new flows; full suites green.
