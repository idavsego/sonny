# Бэкенд чата Сонни

Приложение `sonny-v9.html` само к модели не обращается: ключ Anthropic нельзя
держать в HTML — его увидит любой, кто откроет исходник страницы. Страница
отправляет сообщение сюда, этот сервер добавляет ключ и пересылает запрос дальше.

## Что он делает

- Держит ключ только в переменной окружения на сервере
- Разрешает запросы только с твоих доменов (CORS)
- Ограничивает модель, размер запроса и 20 запросов в минуту с одного адреса
- Не отдаёт клиенту подробности ошибок провайдера

## Локальный запуск

```
cd server
npm install
cp .env.example .env     # вписать свой ключ
ANTHROPIC_API_KEY=sk-ant-... node chat.mjs
```

Проверка, что живой: `curl http://localhost:8787/health` → `{"ok":true}`

Затем в `sonny-v9.html` в блоке `CONFIG` указать адрес:

```
CHAT_URL:'http://localhost:8787'
```

## Запуск на сервере (Timeweb VPS)

```
git clone https://github.com/idavsego/sonny.git
cd sonny/server
npm install --omit=dev
```

Чтобы процесс не умирал после выхода из консоли и поднимался после ребута —
systemd-юнит в `/etc/systemd/system/sonny-chat.service`:

```
[Unit]
Description=Sonny chat backend
After=network.target

[Service]
WorkingDirectory=/root/sonny/server
Environment=ANTHROPIC_API_KEY=sk-ant-...
Environment=ALLOWED_ORIGINS=https://твой-домен.ru
Environment=PORT=8787
ExecStart=/usr/bin/node chat.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

```
systemctl daemon-reload
systemctl enable --now sonny-chat
systemctl status sonny-chat
```

Наружу порт 8787 выставлять не надо — пусть его закрывает nginx, который уже
отдаёт сайт по HTTPS:

```
location /api/chat/ {
    proxy_pass http://127.0.0.1:8787/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

Тогда в приложении: `CHAT_URL:'https://твой-домен.ru/api/chat/'`

## Если Anthropic недоступен из твоего региона

Сервер в России может не иметь доступа к `api.anthropic.com`. Варианты:

1. Держать этот бэкенд на хостинге в регионе, откуда провайдер доступен,
   а сайт оставить на Timeweb — страница обращается к бэкенду по HTTPS,
   где он стоит, ей всё равно.
2. Заменить провайдера модели. Менять нужно **только** вызов
   `client.messages.create` в `chat.mjs` — приложение и системный промпт
   с методикой сна не трогаются вообще. Методика провайдеро-независима.

Проверить доступность с сервера, прежде чем что-то решать:

```
curl -s -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/v1/models \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"
```

`200` — доступ есть. Таймаут или `403` — провайдер из этого региона не отвечает.

## Про модель

В `CONFIG.MODEL` сейчас `claude-opus-5-5` — самая способная. Сервер также
принимает `claude-sonnet-5-5` (дешевле примерно в 2,5 раза, для тёплых коротких
ответов обычно хватает) и `claude-haiku-4-5` (самая дешёвая и быстрая).
Менять — одна строка в `CONFIG` приложения.

Старый id `claude-sonnet-4-20250514`, который стоял в приложении раньше, убран:
он не из текущего поколения моделей.
