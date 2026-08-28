# openGym fail2ban setup

This directory holds the fail2ban config for the openGym server. The
files here are **not auto-installed** — the agent that produced them
does not have sudo on this host. Drop them in by hand and enable.

## What's here

- `nginx-http-opengym.conf` — filter that matches the openGym-web
  container's access log lines. Treats any 4xx/5xx as a fail; tolerates
  the docker stdout prefix used by `docker logs`.
- `jail-openGym.local` — two jails:
  - `opengym-auth` — 5 failures in 10 min on `/api/register` or
    `/api/login` → 24h ban. Stops passkey-enumeration cold.
  - `opengym-scan` — 30 failures in 10 min anywhere → 1h ban. Catches
    script-driven scanners without false-positives on legitimate bad URLs.

## Install (manual, one time)

```bash
# 1. Install the package
sudo apt-get install -y fail2ban

# 2. Make sure docker compose writes openGym-web logs to a file fail2ban
#    can tail. Add this to the web service in docker-compose.yml:
#
#    web:
#      logging:
#        driver: json-file
#        options:
#          max-size: "10m"
#          max-file: "3"
#          tag: "opengym-web"
#
#    Then restart: docker compose up -d web
#
# 3. Symlink the host-side docker log into a stable path. The tag makes
#    the json-file name predictable; the actual filename is the container
#    ID with .json log extension:
sudo mkdir -p /var/log/openGym
LOG=$(sudo docker inspect --format='{{.LogPath}}' opengym-web-1)
sudo ln -sf "$LOG" /var/log/openGym/access.log
sudo systemctl restart docker  # not needed, just an example

# 4. Drop in the filter and jail
sudo cp fail2ban/nginx-http-opengym.conf /etc/fail2ban/filter.d/
sudo cp fail2ban/jail-openGym.local /etc/fail2ban/jail.d/

# 5. Enable and reload
sudo systemctl enable --now fail2ban
sudo fail2ban-client reload

# 6. Verify
sudo fail2ban-client status
sudo fail2ban-client status opengym-auth
sudo fail2ban-client status opengym-scan
```

## Operate

```bash
# List currently banned IPs
sudo fail2ban-client get opengym-scan banlist

# Unban a specific IP (e.g. yourself after a test)
sudo fail2ban-client set opengym-scan unbanip 203.0.113.42

# Tail the jail log to see what's being banned and why
sudo tail -f /var/log/fail2ban.log
```

## Why two jails, not one

Auth endpoints are higher-value targets. A bot scanning the SPA HTML is
annoying but harmless — the nginx layer now returns 404 instead of the SPA
shell, so a scanner gets no useful response. A bot hammering `/api/login`
or `/api/register` is **trying to forge an account** and gets a much
shorter leash.