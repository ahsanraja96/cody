# Tabfold's public site

A few static files, with no build step: the home page (`index.html`), the page people see when
someone shares a folder with them (`s.html`, at `/s/<id>`), and the privacy policy and terms
(`/privacy` and `/terms`, which the Chrome Web Store listing and Tabfold's settings link to). The
shared folder page asks the Tabfold server for the folder (`GET <API_URL>/public/shares/<id>`) and
shows its name, its note (when it has one) and its pages.

| File | What it is |
| --- | --- |
| `index.html`, `home.js` | The home page: what Tabfold is, and a link to the Chrome Web Store. |
| `s.html`, `s.js` | A shared folder: its name and note, Open all, Copy links, the pages, and Save to my Tabfold. |
| `privacy.html`, `terms.html` | The privacy policy and terms. Fill in the placeholders first (below). |
| `style.css`, `favicon.svg` | Looks, light and dark (it follows the visitor's system). |
| `config.js` | The three settings below. Edit it before you deploy. |
| `_redirects` | Sends every `/s/<id>` to `s.html`, and `/privacy` and `/terms` to their pages (Netlify reads it). |
| `_headers` | Security headers, and keeps shared folders out of search engines (Netlify reads it). |

## Settings (`config.js`)

| Setting | What to put |
| --- | --- |
| `API_URL` | The Tabfold server: `https://<project id>.supabase.co/functions/v1/tabfold`, no slash at the end. |
| `EXTENSION_ID` | Tabfold's Chrome id (32 letters, in the Chrome Web Store dashboard). Leave it empty until it's published. |
| `STORE_URL` | Tabfold's page on the Chrome Web Store. |

Nothing in `config.js` is secret: anyone can read it.

## Before you publish: the privacy policy and terms

`privacy.html` and `terms.html` have placeholders, highlighted on the page, for you to replace with
your own details (the owner, "Truewidgets, a division of Loom Factor", is filled in): `[Contact email]`, `[Effective date]`,
`[Country/State for governing law]` (terms) and `[Server region]` (privacy: the region of your
Supabase project, **Project Settings → General**). Search the two files for `class="placeholder"`,
replace each `<span class="placeholder">[…]</span>` with plain text, and read both pages through:
they describe what Tabfold 1.0 does, and they're plain-language drafts, not legal advice.

## Deploy to Netlify

1. Sign in at [netlify.com](https://netlify.com).
2. Edit `web/config.js` (above).
3. **Add new site → Deploy manually**, and drag the `web` folder onto the page. Netlify gives it an
   address such as `https://tabfold-1234.netlify.app`.

   Or, if Tabfold's code is on GitHub: **Add new site → Import an existing project**, pick the
   repository, set **Base directory** and **Publish directory** to `web`, and leave **Build
   command** empty. Every push then deploys again.
4. To use your own domain (for example `tabfold.app`): **Domain management → Add a domain**, then
   add the DNS records Netlify shows where you bought the domain. Netlify sets up HTTPS by itself.
5. Tell the server where the site is, from the `server` folder:

   ```sh
   supabase secrets set SHARE_BASE_URL=https://tabfold.app
   ```

   Shared folder links (`https://tabfold.app/s/<id>`) and the link in team invitations use it.

To check it, share a folder from Tabfold Pro and open the link in a private window: you should see
the folder's name and pages. A link to a folder that isn't shared any more says "This link doesn't
work any more".

## Save to my Tabfold

The button asks Tabfold to add the folder, when Tabfold is installed: the page calls
`chrome.runtime.sendMessage(EXTENSION_ID, { type: 'tabfold-save-share', id })`. That works only if
the extension's manifest lets this site talk to it (`"externally_connectable": { "matches":
["https://tabfold.app/*"] }`, with your domain). Otherwise, or when Tabfold isn't installed, the
button opens `STORE_URL`.

## Trying it on your computer

Any static server works, but `/s/<id>` needs the rewrite. Without one, open
`s.html?id=<id>` instead, for example with `npx serve web` and
`http://localhost:3000/s.html?id=k3J9wQe2ab`. The server must allow it: `GET /public/shares/<id>`
answers any site.
