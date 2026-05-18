# Marshal

Marshal is a browser-based workforce app for Rock N Water Landscapes schedules, staff requests, and internal messages.

Open `index.html` in a browser to run it locally. When hosted on Netlify with Functions enabled, staff, schedules, requests, messages, setup changes, and channels sync through the hosted shared data store. If the cloud store is unavailable, Marshal falls back to saving on the current device.

## Included

- Today dashboard with coverage, open shifts, pending requests, and weekly roster totals.
- Weekly schedule with create, edit, delete, copy, and paste shift actions.
- Team message channels for announcements, operations, and managers.
- Staff directory with add, edit, and delete employee actions.
- Employee records use name, initials, role, phone, and status.
- Simple leave, availability, and shift-swap requests with editable statuses.
- Setup page for business name, sidebar label, work areas, and message channels.
- Backup export and import from the Setup page.
- Installable phone app support through a web app manifest and service worker.
- Browser notifications for saved shifts, staff updates, messages, and requests on the current device.
- Shared Netlify cloud data storage so PC and phone edits can sync through the hosted site.
- Email and password sign-in with a first-run owner account and admin-created employee accounts.

## Phone install and notifications

Marshal can be installed on phones once it is served over `https://` or from `localhost` during testing. Use the **Install app** button where supported, or use the browser menu to add it to the home screen.

The current notification support is local to the device that has Marshal open and has granted notification permission. Sending schedule and message push notifications to all employee phones requires a hosted shared backend with web push subscriptions.

## Netlify hosting

Marshal is ready to host on Netlify. For phone-to-PC syncing, deploy it through Git or the Netlify CLI so Netlify installs the `@netlify/blobs` dependency and deploys the serverless functions in `netlify/functions`.

Best option for shared saving:

1. Sign in to Netlify.
2. Put this project in a GitHub repository.
3. In Netlify, choose **Add new site** and connect the repository.
4. Leave the build command empty.
5. Set publish directory to `.`.
6. Netlify will give you a public `https://` address.
7. Rename the site in Netlify settings if you want a simpler address.

Required environment variables for shared saving and sign-in:

- `MARSHAL_NETLIFY_SITE_ID`: your Netlify Project ID from **Project configuration > General > Project information**.
- `MARSHAL_NETLIFY_TOKEN`: a Netlify personal access token from **User settings > Applications > Personal access tokens**.

After adding or changing environment variables, trigger a fresh deploy. If the sign-in page still reports a service error, open `https://your-site-name.netlify.app/.netlify/functions/auth` and check the JSON error detail.

Static upload option:

Manual folder upload can show the app, but shared PC-to-phone saving may not work because Netlify may not install and bundle the cloud function dependencies from a drag-and-drop deploy.

## Sign-in

On the first hosted visit, Marshal asks you to create the owner account. After that, everyone must sign in with email and password.

The owner/admin can create employee login accounts from **Setup > Login accounts**. Passwords are hashed in the Netlify Function before being stored. The sign-in and shared data Functions use Netlify's newer `.mjs` Function format so Netlify Blobs is available in production.

## Good next steps

- Add role-based permissions if employees should view schedules but not edit everything.
- Add roster publishing, real employee push notifications, and payroll export.
