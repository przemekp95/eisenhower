# Web guide for users and administrators

## Start using the board

1. Open the Eisenhower web page.
2. Enter the access code provided by your administrator. If you do not have a code, contact the person who manages the system.
3. Add a task title and, if useful, a description.
4. Mark the task as **urgent** when it needs attention soon. Mark it as **important** when it supports a meaningful goal.
5. The board places the task under the matching decision: do now, delegate, schedule, or remove.

The access code stays only in the current browser tab. It is removed when you sign out or close the tab. Do not save it in notes, screenshots, or a shared password field.

## Change or remove a task

- Use **Edit** to change a task title or description.
- Use the urgent and important buttons to move a task without dragging it. This path works with a keyboard and on a phone.
- Removing a task always requires two separate actions. The **Remove** quadrant is only a planning decision; it does not delete the task by itself.
- If another person or tab changed the same task first, your draft remains visible. Refresh the board, compare the latest task, and decide whether to save your draft again.

## Understand the status

- **Your tasks are up to date** appears only after the latest request succeeds.
- **No connection** means the visible board may be out of date. Use **Try again** after restoring the connection.
- A failed create or edit keeps the draft in place and shows the next safe step beside that task or form.

## Administration

Open **Administration** from the board header. You do not need to create or name a task first.

The administrator code is separate from the ordinary access code and is also kept only in the current tab. Each control has a permanent label and describes its effect. Turning off a feature, refreshing suggestions, and clearing learned examples require an explicit confirmation. While an action is running, its controls are disabled to prevent duplicate changes.

If administration changes are disabled in the current environment, the panel is read-only. This is intentional: the browser does not bypass server roles, permissions, or production safety gates.

## Current sign-in limitation

The supported deployment still uses the existing static Bearer access model. The clearer screens do not create personal accounts, password recovery, or a new identity provider. Moving to individual accounts requires a separate product and infrastructure decision. Until then, the system owner must distribute and rotate the two access codes through an approved secure channel.
