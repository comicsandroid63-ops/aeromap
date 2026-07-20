# 🚀 Guía de Despliegue - AeroMap

## Opciones Rápidas

### ⚡ Vercel (La más fácil)

```bash
# 1. Inicializar Git
git init
git add .
git commit -m "AeroMap - Initial"

# 2. Subir a GitHub
git branch -M main
git remote add origin https://github.com/usuario/aeromap.git
git push -u origin main

# 3. En Vercel.com:
# - Click "New Project"
# - Seleccionar repo
# - Deploy automático
```

**URL:** `aeromap.vercel.app`
**Costo:** Gratis (hasta 100 invocaciones/día)

---

### 🚂 Railway.app

```bash
# 1. Conectar GitHub en https://railway.app
# 2. Click "New Project"
# 3. Seleccionar repositorio
# 4. Automático - listo!
```

**URL:** Railway genera automáticamente
**Costo:** $5/mes
**Ventaja:** Mejor para archivos grandes

---

### 💻 Servidor Personal (VPS / Dedicado)

```bash
# 1. SSH al servidor
ssh usuario@tu-servidor.com

# 2. Clonar repo
git clone https://github.com/usuario/aeromap.git
cd aeromap

# 3. Instalar Node.js (si no está)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 4. Instalar dependencias
npm install --production

# 5. Crear carpeta uploads
mkdir uploads
chmod 755 uploads

# 6a. Opción A - Usar PM2 (Recomendado)
npm install -g pm2
pm2 start server.js --name aeromap
pm2 save
pm2 startup

# 6b. Opción B - Usar Systemd (Linux)
sudo nano /etc/systemd/system/aeromap.service
```

**Archivo systemd:**
```ini
[Unit]
Description=AeroMap Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/home/usuario/aeromap
ExecStart=/usr/bin/node /home/usuario/aeromap/server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable aeromap
sudo systemctl start aeromap
sudo systemctl status aeromap
```

---

## 🔒 SSL/HTTPS (Obligatorio)

### Con Let's Encrypt (Gratis)

```bash
# Instalar Certbot
sudo apt-get install certbot python3-certbot-nginx

# Generar certificado
sudo certbot certonly --standalone -d aeromap.tudominio.com

# Auto-renovación (automática cada 90 días)
```

### Con Nginx (Reverse Proxy)

```bash
sudo apt-get install nginx

# Crear config en /etc/nginx/sites-available/aeromap
```

**nginx.conf:**
```nginx
server {
    listen 80;
    server_name aeromap.tudominio.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name aeromap.tudominio.com;

    ssl_certificate /etc/letsencrypt/live/aeromap.tudominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/aeromap.tudominio.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        client_max_body_size 500M;
    }

    location /uploads/ {
        alias /home/usuario/aeromap/uploads/;
        expires 24h;
    }
}
```

```bash
sudo systemctl enable nginx
sudo systemctl start nginx
```

---

## 📊 Monitoreo & Mantenimiento

### Ver logs
```bash
# PM2
pm2 logs aeromap

# Systemd
sudo journalctl -u aeromap -f

# Nginx
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log
```

### Limpiar uploads antiguos
```bash
# Script de limpieza (cron)
find /home/usuario/aeromap/uploads -type f -mtime +7 -delete
```

**Agregar a crontab:**
```bash
crontab -e
# Agregar línea:
0 0 * * * find /home/usuario/aeromap/uploads -type f -mtime +7 -delete
```

### Monitoreo de CPU/Memoria
```bash
npm install -g pm2-monitoring
pm2 install pm2-auto-pull
```

---

## 🐳 Docker (Container)

**Dockerfile:**
```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY public/ ./public/
COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
```

**docker-compose.yml:**
```yaml
version: '3.8'
services:
  aeromap:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./uploads:/app/uploads
    environment:
      - NODE_ENV=production
      - PORT=3000
```

**Build & Run:**
```bash
docker-compose up -d
```

---

## ⚠️ Seguridad

### Hardening de servidor

```bash
# Firewall
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable

# Actualizar sistema
sudo apt-get update && sudo apt-get upgrade -y

# Limitar tamaño uploads en server.js
fileSize: 500 * 1024 * 1024  // 500MB máximo

# Sanitizar nombres de archivo
```

---

## 🧪 Testing Post-Deployment

```bash
# Verificar servidor activo
curl https://aeromap.tudominio.com

# Probar upload
curl -X POST -F "files=@test.zip" https://aeromap.tudominio.com/api/upload

# Ver files
curl https://aeromap.tudominio.com/api/files
```

---

## ⏱️ Roadmap de Actualización

1. **Versión 3.1** - Base de datos PostgreSQL
2. **Versión 3.2** - API REST completa
3. **Versión 4.0** - Colaboración en tiempo real

---

**Preguntas frecuentes:**

**P: ¿Puedo usar el servidor gratuitamente?**
R: Sí, Vercel ofrece hosting gratuito con límites de invocación.

**P: ¿Cuánto almacenamiento necesito?**
R: Mínimo 10GB para uploads de GIS (recomendado 50GB+)

**P: ¿Se ejecuta offline?**
R: Solo la parte web. Los archivos se suben al servidor para procesamiento.

**P: ¿Qué pasaconlos datos subidos?**
R: Se guardan en `uploads/` - tú controlas. Implementa limpieza automática.

---

**Última actualización:** Marzo 2026
