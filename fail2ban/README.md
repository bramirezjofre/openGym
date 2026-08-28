# openGym fail2ban setup

This directory holds the fail2ban config for the openGym server.

## What's here

- `nginx-http-opengym.conf` — filter that matches the combined-format
  nginx access log written by the openGym-web container at
  `/var/log/opengym/access.log` (bind-mounted from the host).
- `jail-openGym.local` — two jails:
  - `opengym-auth` — 5 failures in 10 min on `/api/register` or
    `/api/login` → 24h ban. Stops passkey-enumeration cold.
  - `opengym-scan` — 30 failures in 10 min anywhere → 1h ban. Catches
    script-driven scanners without false-positives on legitimate bad URLs.

## Install (manual, one time)

The agent that produced these configs does not have sudo on this host,
so the install is manual. The config files themselves are already
committed; you only need to drop them in the right place and reload.

```bash
# 1. Install fail2ban
sudo apt-get install -y fail2ban

# 2. Create the log directory and chown it so nginx (uid 101 inside the
#    container) can write to the bind mount. The bind source must exist
#    before docker-compose can mount it.
sudo mkdir -p /var/log/opengym
sudo chown 101:101 /var/log/opengym

# 3. Drop in the filter and jail
sudo cp fail2ban/nginx-http-opengym.conf /etc/fail2ban/filter.d/
sudo cp fail2ban/jail-openGym.local /etc/fail2ban/jail.d/

# 4. Validate, then enable
sudo fail2ban-client --test
sudo systemctl enable --now fail2ban
sudo fail2ban-client reload

# 5. Verify
sudo fail2ban-client status
sudo fail2ban-client status opengym-auth
sudo fail2ban-client status opengym-scan
```

## How the logs flow now

```
Browser request
     ↓
Nginx Proxy Manager (HTTPS, terminates TLS)
     ↓
opengym-web container (nginx on :80)
     ↓
access_log /var/log/opengym/access.log
     ↓
/var/log/opengym/access.log   ← bind-mount: same file, host side
     ↓
fail2ban (tailing /var/log/opengym/access.log)
     ↓
nftables ban
```

The bind-mount is stable across container recreates — the file path on
the host never changes, so the symlink-via-docker-logpath workaround
(used in the first iteration) is no longer needed.

## Operate

```bash
# List currently banned IPs
sudo fail2ban-client status opengym-auth
sudo fail2ban-client status opengym-scan

# Unban a specific IP (e.g. yourself after a test)
sudo fail2ban-client set opengym-auth unbanip 203.0.113.42

# Tail the jail log to see what's being banned and why
sudo tail -f /var/log/fail2ban.log
```

## Why two jails, not one

Auth endpoints are higher-value targets. A bot scanning the SPA HTML is
annoying but harmless — the nginx layer now returns 404 instead of the SPA
shell, so a scanner gets no useful response. A bot hammering `/api/login`
or `/api/register` is **trying to forge an account** and gets a much
shorter leash.