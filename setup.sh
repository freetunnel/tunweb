#!/usr/bin/bash 

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
REPO="https://raw.githubusercontent.com/freetunnel/tunweb/main"

need_root(){ [[ $EUID -ne 0 ]] && echo -e "${RED}[ERR] Jalankan sebagai root.${NC}" && exit 1; }
ce() { command -v "$1" >/dev/null 2>&1; }

prompt_domain(){
  echo -e "${YELLOW}Masukkan subdomain (contoh: panel.example.com):${NC}"
  read -r DOMAIN
      echo "$domain" > /etc/xray/DOMAIN
  [[ -z "$DOMAIN" ]] && echo -e "${RED}[ERR] Subdomain kosong.${NC}" && exit 1
}

install_deps(){
  echo -e "${GREEN}[+] Install dependensi...${NC}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl wget jq unzip socat lsof git build-essential \
  ufw nginx sqlite3 openssl ca-certificates gnupg netcat-openbsd  if ! ce node; then
    echo -e "${GREEN}[+] Install Node.js LTS...${NC}"
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y nodejs
  fi
  if ! ce sponge; then
    cat >/usr/bin/sponge <<'SP'
#!/usr/bin/env bash
TMP=$(mktemp); cat >"$TMP"; cat "$TMP" >"$1"; rm -f "$TMP"
SP
    chmod +x /usr/bin/sponge
  fi
}

install_xray(){
  echo -e "${GREEN}[+] Install Xray core...${NC}"
  if ! ce xray; then
    bash <(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh) install
  fi
  systemctl stop xray || true
}

write_xray_config(){
  echo -e "${GREEN}[+] Konfigurasi Xray...${NC}"
  mkdir -p /etc/xray /var/log/xray /etc/ssl/xray
  cat >/etc/xray/config.json <<'JSON'
{
  "log": {"loglevel": "info", "access": "/var/log/xray/access.log"},
  "policy": {
    "levels": {"0": {"statsUserUplink": true, "statsUserDownlink": true}},
    "system": {"statsInboundUplink": true, "statsInboundDownlink": true}
  },
  "stats": {},
  "api": {"services": ["HandlerService","LoggerService","StatsService"], "tag": "api"},
  "inbounds": [
    {"listen":"127.0.0.1","port":10085,"protocol":"dokodemo-door","settings":{"address":"127.0.0.1"},"tag":"api"},
    {"listen":"127.0.0.1","port":10001,"protocol":"vmess","settings":{"clients":[]},"streamSettings":{"network":"ws","wsSettings":{"path":"/vmess"}},"tag":"vmess-ws"},
    {"listen":"127.0.0.1","port":10002,"protocol":"vless","settings":{"decryption":"none","clients":[]},"streamSettings":{"network":"ws","wsSettings":{"path":"/vless"}},"tag":"vless-ws"},
    {"listen":"127.0.0.1","port":10003,"protocol":"trojan","settings":{"clients":[]},"streamSettings":{"network":"ws","wsSettings":{"path":"/trojan"}},"tag":"trojan-ws"}
  ],
  "outbounds": [{"protocol":"freedom","tag":"direct"},{"protocol":"blackhole","tag":"blocked"}],
  "routing": {"rules":[{"type":"field","inboundTag":["api"],"outboundTag":"api"}]}
}
JSON
  [[ -f /etc/xray/users.json ]] || echo '{"users":[]}' >/etc/xray/users.json
}

download_files(){
  echo -e "${GREEN}[+] Download file panel & helper dari GitHub...${NC}"
  mkdir -p /usr/bin/xpanel /var/lib/xtool
  wget -qO /usr/bin/xpanel/server.js        "$REPO/server.js"
  wget -qO /usr/bin/xuser                   "$REPO/xuser"
  wget -qO /usr/bin/usage_daemon.sh         "$REPO/usage_daemon.sh"
  wget -qO /etc/nginx/sites-available/xpanel.conf.tpl "$REPO/xpanel.conf.tpl"
  chmod 755 /usr/bin/xuser /usr/bin/usage_daemon.sh
}

issue_cert(){
  echo -e "${GREEN}[+] Dapatkan sertifikat TLS (acme.sh)...${NC}"
systemctl stop nginx
    mkdir /root/.acme.sh
    curl https://acme-install.netlify.app/acme.sh -o /root/.acme.sh/acme.sh
    chmod +x /root/.acme.sh/acme.sh
    /root/.acme.sh/acme.sh --upgrade --auto-upgrade
    /root/.acme.sh/acme.sh --set-default-ca --server letsencrypt
    /root/.acme.sh/acme.sh --issue -d $DOMAIN--standalone -k ec-256
    /root/.acme.sh/acme.sh --installcert -d $DOMAIN--fullchainpath /etc/xray/xray.crt --keypath /etc/xray/xray.key --ecc
}

setup_nginx(){
  echo -e "${GREEN}[+] Setup Nginx reverse proxy...${NC}"
  sed "s/_DOMAIN_/$DOMAIN/g" /etc/nginx/sites-available/xpanel.conf.tpl >/etc/nginx/sites-available/xpanel.conf
  ln -sf /etc/nginx/sites-available/xpanel.conf /etc/nginx/sites-enabled/xpanel.conf
  rm -f /etc/nginx/sites-enabled/default || true
  nginx -t
  systemctl enable --now nginx
}

install_services(){
  echo -e "${GREEN}[+] Buat systemd service...${NC}"
  cat >/etc/systemd/system/xtool-web.service <<EOF
[Unit]
Description=Xray Web Panel (Node.js)
After=network.target

[Service]
Environment=XTOOL_DOMAIN=${DOMAIN}
WorkingDirectory=/usr/bin/xpanel
ExecStart=/usr/bin/node /usr/bin/xpanel/server.js
Restart=always
User=root

[Install]
WantedBy=multi-user.target
EOF

  cat >/etc/systemd/system/xtool-usage.service <<'EOF'
[Unit]
Description=Xray Usage Monitor & Enforcer
After=network.target xray.service
Requires=xray.service

[Service]
ExecStart=/usr/bin/usage_daemon.sh
Restart=always
User=root

[Install]
WantedBy=multi-user.target
EOF
}

start_all(){
  systemctl daemon-reload
  systemctl enable xray
  systemctl restart xray
  systemctl enable --now xtool-web
  systemctl enable --now xtool-usage
}

print_summary(){
  echo -e "${GREEN}
Instalasi selesai!
Panel:   http://${DOMAIN}  |  https://${DOMAIN}

WS (80):   /vmess  /vless  /trojan
WSS (443): /vmess  /vless  /trojan
Services:  xray, xtool-web, xtool-usage
Config:    /etc/xray/config.json, /etc/xray/users.json
${NC}"
}

main(){
  need_root
  prompt_domain
  install_deps
  install_xray
  write_xray_config
  download_files
  issue_cert
  setup_nginx
  install_services
  start_all
  print_summary
}
main "$@"
