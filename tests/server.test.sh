set -u
B="http://127.0.0.1:8799"
ok=0; fail=0
chk(){ if [ "$2" = "$3" ]; then echo "  OK  $1"; ok=$((ok+1)); else echo "  FAIL $1 -> ожидал [$3], получил [$2]"; fail=$((fail+1)); fi; }
code(){ curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$@"; }
body(){ curl -s --noproxy '*' "$@"; }
J='Content-Type: application/json'
MINE='Origin: https://sonny.ru'

echo "=== 1. Доступ (ALLOWED_ORIGINS=https://sonny.ru) ==="
chk "health" "$(body $B/health)" '{"ok":true}'
chk "свой домен проходит дальше проверки Origin" "$(code -X POST $B/ -H "$MINE" -H "$J" -d '{}')" "400"
chk "чужой домен -> 403" "$(code -X POST $B/ -H 'Origin: https://evil.ru' -H "$J" -d '{"messages":[{"role":"user","content":"x"}]}')" "403"
chk "без Origin -> 403" "$(code -X POST $B/ -H "$J" -d '{"messages":[{"role":"user","content":"x"}]}')" "403"
chk "GET -> 405" "$(code $B/)" "405"
chk "preflight своего домена -> 204" "$(code -X OPTIONS $B/ -H "$MINE")" "204"
chk "заголовок allow-origin чужому не выдан" "$(curl -s --noproxy '*' -i -X OPTIONS $B/ -H 'Origin: https://evil.ru' | grep -ci 'allow-origin')" "0"

echo "=== 2. Размер тела ==="
python3 -c "print('{\"messages\":[{\"role\":\"user\",\"content\":\"' + 'я'*150000 + '\"}]}')" > /tmp/big.json
chk "300 КБ -> 413" "$(code -X POST $B/ -H "$MINE" -H "$J" --data-binary @/tmp/big.json)" "413"
chk "тело ответа внятное" "$(body -X POST $B/ -H "$MINE" -H "$J" --data-binary @/tmp/big.json)" '{"error":"Запрос слишком большой"}'

echo "=== 3. Валидация ==="
chk "битый JSON" "$(body -X POST $B/ -H "$MINE" -H "$J" -d 'не json')" '{"error":"Некорректный запрос"}'
chk "роль system отклонена" "$(body -X POST $B/ -H "$MINE" -H "$J" -d '{"messages":[{"role":"system","content":"x"}]}')" '{"error":"Нет сообщений"}'
chk "пустой текст" "$(body -X POST $B/ -H "$MINE" -H "$J" -d '{"messages":[{"role":"user","content":"   "}]}')" '{"error":"Нет сообщений"}'
chk "messages строкой" "$(body -X POST $B/ -H "$MINE" -H "$J" -d '{"messages":"привет"}')" '{"error":"Нет сообщений"}'
chk "отрицательный max_tokens не падает в 500" "$(code -X POST $B/ -H "$MINE" -H "$J" -d '{"max_tokens":-5,"messages":[{"role":"user","content":"x"}]}')" "401"
chk "чужая модель не ломает сервер" "$(code -X POST $B/ -H "$MINE" -H "$J" -d '{"model":"gpt-4","messages":[{"role":"user","content":"x"}]}')" "401"

echo "=== 4. Лимит запросов (21 подряд, TRUST_PROXY=0) ==="
last=""
for i in $(seq 1 21); do
  last=$(code -X POST $B/ -H "$MINE" -H "$J" -H "X-Forwarded-For: 1.2.3.$i" -d '{"messages":[{"role":"user","content":"x"}]}')
done
chk "21-й запрос -> 429 (подмена X-Forwarded-For не помогла)" "$last" "429"
echo
echo "ИТОГ: прошло $ok, упало $fail"
