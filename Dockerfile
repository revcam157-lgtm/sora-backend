FROM node:18-slim

# Instala ffmpeg, yt-dlp e python (necessário para yt-dlp)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install

COPY server.js .

RUN mkdir -p output cookies

EXPOSE 8080

CMD ["node", "server.js"]
