# Oracle Cloud (OCI) la deploy panna

## 1. VM create
- Compute > Instances > Create. Image: **Ubuntu 22.04**. Shape: Always Free (AMD E2.1.Micro or Ampere A1).
- SSH key download pannitu vaiyunga. Public IP assign aagum.

## 2. Ports open (2 idathula pannanum)
**a) OCI console:** Networking > VCN > Subnet > Security List > Add Ingress Rules
Source `0.0.0.0/0`, TCP, Destination port `80` and `443`.

**b) VM ullae (Oracle Ubuntu-la iptables block irukkum):**
```
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```
(`netfilter-persistent` illaina: `sudo apt install -y iptables-persistent`)

## 3. Docker install
```
sudo apt update && sudo apt install -y docker.io docker-compose-v2 unzip
sudo usermod -aG docker $USER   # then logout/login
```

## 4. 1 GB RAM VM (E2.1.Micro) na swap add pannunga (illaina build fail aagum)
```
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 5. Project upload + run
```
scp -i key.pem codex-online-compiler.zip ubuntu@<PUBLIC_IP>:~
ssh -i key.pem ubuntu@<PUBLIC_IP>
unzip codex-online-compiler.zip -d app && cd app
cp .env.example .env && nano .env     # JUDGE0_* , SITE_ADDRESS set pannunga
docker compose up -d --build
```
Open: `http://<PUBLIC_IP>` (or your domain).

## 6. Domain + HTTPS (optional)
Domain-oda A record -> VM public IP. `.env` la `SITE_ADDRESS=compiler.yourdomain.com`, then `docker compose up -d`. Caddy thaane HTTPS certificate edukkum.

## Useful
```
docker compose logs -f app     # logs
docker compose up -d --build   # update pannina apram
docker compose down            # stop
```
