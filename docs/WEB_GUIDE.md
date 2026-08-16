# Web guide for business users

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

## Business administration

Business administrators use the same business language and workflows as other users. The product does not expose providers, models, training data, queues, workflows, indexes, credentials, n8n or infrastructure controls. Calendar connection, synchronization progress and conflict resolution remain business actions and are available only when the server reports the corresponding capability.

Technical maintenance is an operator responsibility performed through private deployment and service interfaces outside the web and mobile products. Hiding a control in the browser is not an authorization boundary; operator endpoints remain protected server-side and are not called by product clients.

## Current sign-in limitation

The supported deployment still uses the existing static Bearer access model. The clearer screens do not create personal accounts, password recovery, business roles or a new identity provider. Moving to individual accounts and a distinct business-administrator role requires a separate product and infrastructure decision. Until then, the system owner must distribute and rotate the product access code through an approved secure channel; the separate operator credential must never be entered into a product client.
