1. `npx wrangler kv namespace create LOGS`를 실행해 나온 id를 `wrangler.toml`의 `REPLACE_ME`에 입력한다.
2. `npx wrangler secret put PASS_HASH` 후 학생 암호의 SHA-256 hex를 입력한다.
3. `npx wrangler secret put TEACHER_HASH` 후 교사 암호의 SHA-256 hex를 입력한다.
4. 필요하면 `ALLOWED_ORIGIN`을 배포할 사이트 주소로 바꾼다.
5. `npx wrangler deploy`를 실행하고 반환된 Worker 주소를 `site/config.js`의 `syncUrl`에 입력한다.
