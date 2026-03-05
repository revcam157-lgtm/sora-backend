FROM node:18-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && pip3 install curl-cffi --break-system-packages \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .

# Cria /tmp/sorawipe com permissões totais
RUN mkdir -p /tmp/sorawipe/output /tmp/sorawipe/uploads && chmod -R 777 /tmp/sorawipe

EXPOSE 8080
CMD ["node", "server.js"]
