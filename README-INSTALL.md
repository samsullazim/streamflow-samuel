# StreamFlow Samuel Custom

Custom StreamFlow build untuk VPS: HTTPS nip.io + Caddy, Google API `Premature close` workaround, bulk rotation metadata, durasi jam/menit, dan repeat hari tertentu.

## Install VPS baru

Repo private butuh token GitHub dengan scope `repo`.

```bash
export GITHUB_TOKEN='ghp_xxx'
curl -fsSL https://raw.githubusercontent.com/samsullazim/streamflow-samuel/main/install-custom.sh -o install-custom.sh
bash install-custom.sh 1.2.3.4
```

Kalau argumen `1.2.3.4`, installer otomatis pakai:

```text
https://1.2.3.4.nip.io
```

Default login:

```text
admin / Aremania87
```

Bisa override:

```bash
ADMIN_USER=admin ADMIN_PASS='password-baru' bash install-custom.sh 1.2.3.4
```

## Backup data

Di VPS lama:

```bash
cd /root/streamflow-github
bash backup-custom.sh
```

Output:

```text
/root/streamflow-backups/streamflow-data-YYYYmmdd-HHMMSS.tar.gz
```

Isi backup:

```text
.env
db/streamflow.db
db/sessions.db
public/uploads
logs
```

## Restore data

Upload backup ke VPS baru, lalu:

```bash
cd /root/streamflow-github
bash restore-custom.sh /root/streamflow-backups/streamflow-data-YYYYmmdd-HHMMSS.tar.gz 1.2.3.4
```

## Update dari repo

```bash
cd /root/streamflow-github
git pull
npm install
systemctl restart streamflow.service
```

## Service

```bash
systemctl status streamflow.service
systemctl status caddy
journalctl -u streamflow.service -f
```

## URL

```text
https://IP.nip.io
```
