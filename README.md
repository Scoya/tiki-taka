# 우리 디데이 (PWA)

둘이 쓰는 디데이 + 캘린더 + 메모 웹앱입니다.

- 디데이: 함께한 날, 100일 단위·N주년 자동 계산, 직접 만드는 디데이(매년 반복)
- 캘린더: 일정 색 선택, 여러 날 일정 막대, 날짜별 사진(폴라로이드 썸네일)
- 메모: 글/체크리스트, 카테고리 필터, 작성자 표시
- 공유: Supabase로 두 폰 실시간 동기화 (오프라인에서도 쓰고, 연결되면 자동 전송)

## 파일 구성
- `index.html`: 앱 화면과 기능
- `sync.js`: Supabase 동기화
- `config.js`: Supabase 주소와 키 (직접 입력)
- `setup.sql`: Supabase에 한 번 실행할 데이터베이스 설정
- `vendor/supabase.js`: Supabase 라이브러리 (오프라인에서도 앱이 열리도록 함께 포함)
- `sw.js`, `manifest.json`, `icons/`: 홈 화면 앱 설정

## 1. Supabase 준비 (한 번만)
1. https://supabase.com 에 가입하고 **New project**를 만듭니다.
   - Region은 **Northeast Asia (Seoul)** 을 고르세요.
   - Database password는 따로 적어 두세요.
2. 왼쪽 메뉴 **SQL Editor** → **New query**에 `setup.sql` 내용을 전부 붙여넣고 **Run**을 누릅니다. "Success"가 나오면 끝입니다.
3. **Authentication → Sign In / Providers → Email**에서 **Confirm email**을 끕니다.
   화면에 Confirm email 대신 **Allow unverified email sign in**이 있다면 그걸 켜세요.
   (이 설정을 안 하면 가입할 때 메일 인증 링크를 눌러야 해요.)
4. **Project Settings → API Keys**(또는 Data API)에서 아래 두 값을 복사해 `config.js`에 넣습니다.
   - Project URL → `supabaseUrl`
   - anon public 키 또는 Publishable key → `supabaseAnonKey`
   - **service_role / secret 키는 절대 넣지 마세요.**

## 2. 배포 (GitHub Pages)
1. GitHub에서 새 저장소를 만듭니다 (예: `our-dday`).
2. 이 폴더의 파일을 전부 올립니다 (`config.js` 포함).
3. 저장소 Settings → Pages → Branch를 `main` / `root`로 지정하고 저장합니다.
4. 1~2분 뒤 `https://아이디.github.io/our-dday/` 주소가 생깁니다.

## 3. 두 폰 연결
1. 두 아이폰 모두 사파리에서 주소를 열고 공유 버튼 → **홈 화면에 추가**.
2. **먼저 쓰던 폰**: 설정 → 공유 연결 → 로그인/가입 → **처음이에요(가입)** → **새로 시작하기**.
   이 폰의 일정·메모·사진이 그대로 올라가고 **초대 코드**가 나옵니다.
3. **상대 폰**: 설정 → 공유 연결 → 다른 이메일로 가입 → 초대 코드 입력 → **연결하기**.
4. (선택) 두 사람 다 가입한 뒤 Supabase **Authentication → Sign In / Providers**에서
   **Allow new users to sign up**을 끄면 다른 사람은 가입할 수 없어요.

## PC에서 미리보기
폴더에서 아래 명령을 실행한 뒤 크롬에서 http://localhost:8000 을 엽니다.

    python -m http.server 8000 --bind 127.0.0.1

## 수정할 때
코드를 고친 뒤 `sw.js` 맨 위의 `CACHE` 이름을 `couple-v6`, `couple-v7`처럼 바꿔서 함께 올리면 폰에도 새 버전이 반영됩니다.

## 알아둘 점
- 같은 항목을 두 사람이 동시에 고치면 나중에 저장된 쪽이 남습니다.
- 사진은 1600px로 줄여 올립니다. Supabase 무료 저장 공간(1GB)에 약 2천~3천 장 들어가요.
- Supabase 무료 프로젝트는 1주일 동안 아무도 쓰지 않으면 일시 정지돼요. 대시보드에서 다시 켜면 되고, 그동안에도 앱은 폰에 저장된 데이터로 열립니다.
- 공휴일은 양력 공휴일만 표시합니다 (설날·추석 등 음력 공휴일과 대체공휴일 제외).
