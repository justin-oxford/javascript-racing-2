# Deploying the game server

The game itself (the page) is on GitHub Pages and deploys on every push to `main`. This file is about the
**multiplayer server**: the Node process that runs every online race. It lives on one small always-on box.

Written for someone who hasn't touched this in six months.

## What's where

| Thing | Where |
|---|---|
| Server code | `src/server/` (entry `serve.ts`), built into one file: `dist-server/server.mjs` |
| Box | AWS Lightsail, Ohio (us-east-2), $5 plan with IPv4, Ubuntu 24.04 LTS. Instance name `javascript-racing-two-race-server`, static IP 3.19.3.36 |
| Address | `https://race.justinoxford.com` (DNS A record `race` → the static IP). The game connects to `wss://race.justinoxford.com` |
| SSH | `ssh -i ~/.ssh/race-server ubuntu@race.justinoxford.com` (key on Justin's computer only) |
| Box setup | `server/setup.sh`: everything installed on the box. Never type one-off commands into the box: change the script and re-run it |
| Deploy settings | `server/deploy.json` (box, key path, URL) |
| Server settings on the box | `/etc/racing.env` (port, allowed origins, and any future secrets; never in git) |
| Releases on the box | `/opt/racing/releases/<time>-<commit>/`, `/opt/racing/current` → the live one (last 5 kept) |
| Data on the box | `/opt/racing/data/` (the leaderboard SQLite file, card 09) |
| Client settings | `config/net.json`: `server.prodUrl` (where the Pages build connects), `server.allowedOrigins` (dev default) |

The flow: browser on `https://justin-oxford.github.io/javascript-racing-2/` → `wss://race.justinoxford.com`
→ Caddy on the box (HTTPS, automatic certificate) → the game server on `127.0.0.1:2567` (systemd service
`racing`).

## Deploy (the one command)

From a checkout on the computer with the SSH key:

```
npm ci
npm run deploy:server
```

It builds the server here, uploads it with the track data, switches the box to it, restarts, and waits for
`https://race.justinoxford.com/health` to report the new commit. It prints `PASS` or `FAIL`. If the new
release doesn't come up, it shows the server log and goes back to the previous release by itself.

Deploy what's committed: uncommitted changes in `src/`, `config/` or `tracks/` still go out, but `/health`
shows the release as `<commit>-dirty`.

Other forms:

- `npm run deploy:server -- --check`: only check `/health`.
- `npm run deploy:server -- --setup`: run `server/setup.sh` on the box first, then deploy. Use it on a fresh
  box, or after changing `setup.sh`. It's safe to re-run any time.

The page (client) and the server are deployed separately. If a change touches both (for example the message
protocol in `src/server/protocol.ts`), deploy the server and push `main` together, or old pages and the new
server won't understand each other.

## First-time setup of a new box

1. Lightsail console (account, billing and DNS stay in Justin's hands):
   - Create instance: Ohio (us-east-2), Linux/Unix, OS only, newest Ubuntu LTS, upload `~/.ssh/race-server.pub`,
     the $5 plan **with IPv4** (not IPv6-only).
   - Networking: create and attach a **static IP**.
   - Networking → IPv4 firewall: exactly SSH 22, HTTP 80, HTTPS 443. (Caddy needs 80 to get its certificate.
     The game port 2567 stays closed: only Caddy talks to it.)
   - DNS: A record `race` → the static IP (where justinoxford.com's DNS lives; don't touch the MX records).
2. Check SSH works: `ssh -i ~/.ssh/race-server ubuntu@race.justinoxford.com`.
3. `npm run deploy:server -- --setup`.

That's all: re-running `setup.sh` on a fresh box rebuilds the whole server.

## When something's wrong

```
ssh -i ~/.ssh/race-server ubuntu@race.justinoxford.com
sudo systemctl status racing              # is it running
sudo journalctl -u racing -n 100 --no-pager   # its log (rooms, races, refused origins, errors)
sudo journalctl -u caddy -n 50 --no-pager     # HTTPS / certificate problems
free -m                                   # memory (0.5 GB box + 1 GB swap)
ls -lt /opt/racing/releases               # what's been deployed
```

- **Go back a release by hand:** `sudo ln -sfn /opt/racing/releases/<older one> /opt/racing/current && sudo systemctl restart racing`.
- **The page can't connect, but /health works:** the page's origin isn't allowed. `ALLOWED_ORIGINS` in
  `/etc/racing.env` must list it exactly (`https://justin-oxford.github.io`, no path, no trailing slash).
  The server log says `refused a WebSocket from ...`. Edit the file, then `sudo systemctl restart racing`.
  (setup.sh only writes that file when it doesn't exist, so your edits stay.)
- **No HTTPS / certificate errors:** ports 80 and 443 must be open in the Lightsail IPv4 firewall, and the
  `race` A record must point at the static IP.
- **Testing a local page against the real server:** the real server only allows the Pages origin. Run the
  server locally instead (`npm run server` + `npm run dev`, open `/?online`).

## Restore (leaderboard data)

Card 09 adds the SQLite database and its nightly backup; the restore steps go here with it.

## Retiring the old website box

Once justinoxford.com is on Pages: delete the old website Lightsail instance **and release its static IP**
(stopped instances and unattached static IPs both keep billing).
