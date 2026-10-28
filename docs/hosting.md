# Hosting on Netlify (free)

Netlify serves the page and runs the API as a function. There's no database: codes and Google details are environment variables, and the user-access settings from the admin panel are saved in Netlify Blobs (built in, free).

1. Finish [Google setup](google-setup.md) first, so your local `.env` has all the Google values.
2. On [netlify.com](https://www.netlify.com): **Add new project → Import from Git → GitHub**, then pick this repo. Leave the build settings as they are; `netlify.toml` handles them.
3. **Site configuration → Environment variables**. Add:

   | Variable                          | Value                                       |
   | --------------------------------- | ------------------------------------------- |
   | `ADMIN_CODE`                      | Your long private code (12+ characters)     |
   | `USER_CODE`                       | The code you give the other person          |
   | `GOOGLE_CLIENT_ID`                | From your `.env`                            |
   | `GOOGLE_CLIENT_SECRET`            | From your `.env`                            |
   | `GOOGLE_DEVICE_ACCESS_PROJECT_ID` | From your `.env`                            |
   | `GOOGLE_REFRESH_TOKEN`            | From your `.env` (written by `google-auth`) |
   | `GOOGLE_DEVICE_ID`                | From your `.env` (written by `google-auth`) |

   Optional: `TEMPERATURE_MIN_C`, `TEMPERATURE_MAX_C` (defaults 10 and 30).

4. **Deploys → Trigger deploy**. Your site is at `https://<name>.netlify.app`. You can rename it under **Site configuration → Change site name**.
5. Open the site and sign in with your admin code. In **User access**, choose the modes, Eco and temperature range for the user.
6. Send the other person the link and their code.

Every push to GitHub redeploys. After changing an environment variable, trigger a deploy for it to take effect.

## Everyday

- **Turn their access off:** flip the switch in **User access**. It takes effect immediately.
- **Change their code:** edit `USER_CODE` and redeploy. They're signed out.
- **Change your code:** edit `ADMIN_CODE` and redeploy. Everyone is signed out.
- **Google stopped working:** run `npm run google-auth` again and copy the new `GOOGLE_REFRESH_TOKEN` to Netlify.

## Without Netlify

`npm start` runs the same app on any computer with Node 22.18+. Put it behind HTTPS and set `APP_ORIGIN` to its address. User-access settings are then saved in `data/access.json`.
