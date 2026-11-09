# ME-LoreVeil (Marinara Engine 서버 런타임)

채팅 메시지 안의 지정한 구간을 **로어북 키워드 검색과 로어북 의미 검색(semantic search) 질의에서만** 숨기는 Marinara Engine 2.5.1·2.5.2용 서버 런타임입니다. 모델에 보내는 프롬프트, 저장된 메시지, 화면 표시는 바뀌지 않습니다.

SillyTavern용 자매 확장은 [ST-LoreVeil](https://github.com/mallang0723/ST-LoreVeil)입니다.

## 무엇을 하나

상태창·트래커처럼 매번 반복되는 블록이 로어북을 계속 건드릴 때, 그 블록만 검색에서 빼 줍니다. 아래 세 가지 표시 중 아무거나 쓰면 됩니다.

```html
<loreveil>검색에서 제외할 내용</loreveil>
!--LOREVEIL_START--!검색에서 제외할 내용!--LOREVEIL_END--!
<div loreveil><ad-stat>상태창 내용</ad-stat></div>
```

상태창 정규식의 출력 결과를 `<div loreveil>…</div>`로 감싸 주세요. 0.2.0부터는 새 표시만 지원하므로 기존 표시를 사용하는 메시지와 정규식 출력도 바꿔야 합니다.

### 규칙

- 표시한 구간은 같은 길이의 공백으로 바뀌어 검색에 들어갑니다. 결과가 공백뿐이면 빈 글이 됩니다.
- 태그·속성 이름은 대소문자를 구분하지 않습니다. START/END 마커는 위처럼 대문자로 씁니다.
- 같은 이름의 중첩 태그와 따옴표 안의 `>`를 처리합니다.
- `class="loreveil"` 같은 속성 값은 제외 표시로 보지 않습니다.
- 닫히지 않은 구간은 메시지 끝까지 제외됩니다.
- 마커 형식을 가장 먼저 처리합니다.

### 영향 범위

| 구분 | 영향 |
|---|---|
| 로어북 키워드 검색 (user·assistant·narrator 메시지, 고정된 검색 메시지 포함) | 제외됨 |
| 로어북 의미 검색 질의, 지식 라우터의 최근 메시지 질의 | 제외됨 |
| 모델에 보내는 프롬프트 | 그대로 |
| 저장된 메시지, 화면 표시 | 그대로 |
| 재귀 검색에 쓰이는 로어북 본문, 캐릭터 설명, 라우터의 요약·게임 상태, 로어북 문서 임베딩 | 그대로 (건드리지 않음) |
| 항상 활성화·sticky·다른 보이는 키워드로 켜지는 항목 | 계속 켜질 수 있음 |

> **검색 제외이지 비밀 삭제가 아닙니다.** 모델은 표시 안쪽 글을 그대로 읽습니다. 숨기고 싶은 정보를 프롬프트에서 지우는 기능이 아닙니다.

## 요구 사항

- Marinara Engine **2.5.1 또는 2.5.2** (루트 패키지와 서버 패키지 버전이 같아야 함)
- Node.js **24~26** (`module.registerHooks` 필요)
- 외부 npm 의존성 없음

다른 버전에서는 아무것도 패치하지 않고 원래대로 동작합니다.

## 설치

서버의 `dist` 파일은 디스크에서 수정하지 않습니다. 서버가 시작될 때 Node의 `--require`로 런타임을 불러와 메모리에서만 적용합니다. `runtime` 폴더와 `lib` 폴더가 함께 있어야 합니다.

### Docker Compose

1. 서버(호스트)의 원하는 경로에 저장소를 받습니다.

   ```bash
   git clone https://github.com/mallang0723/ME-LoreVeil.git /opt/me-loreveil
   ```

2. `docker-compose.override.yml` 등에 읽기 전용 볼륨과 `NODE_OPTIONS`를 추가합니다. **이미 있는 설정에 병합**하세요. 다른 볼륨, `env_file`, 포트, 이미 쓰는 `NODE_OPTIONS`의 다른 `--require`는 그대로 둡니다. 순서는 상관없습니다.

   ```yaml
   services:
     marinara:
       volumes:
         - /opt/me-loreveil:/opt/me-loreveil:ro
       environment:
         NODE_OPTIONS: >-
           --require=/opt/me-loreveil/runtime/ma-loreveil-runtime.cjs
   ```

   다른 런타임 모듈을 이미 쓰고 있다면 한 줄만 더합니다.

   ```yaml
         NODE_OPTIONS: >-
           --require=/opt/다른-모듈/runtime.cjs
           --require=/opt/me-loreveil/runtime/ma-loreveil-runtime.cjs
   ```

3. 컨테이너를 **재생성**합니다. `restart`만으로는 바뀐 환경변수와 볼륨이 적용되지 않습니다.

   ```bash
   docker compose up -d --force-recreate marinara
   docker compose logs --tail=100 marinara
   ```

   (서비스 이름은 본인 설정에 맞게 바꾸세요.)

### Docker 없이

저장소를 받은 뒤, 서버를 시작할 때 `NODE_OPTIONS`에 `--require`를 붙입니다. 시작 명령은 평소 쓰던 것을 그대로 쓰면 됩니다.

```bash
git clone https://github.com/mallang0723/ME-LoreVeil.git
NODE_OPTIONS="--require=$PWD/ME-LoreVeil/runtime/ma-loreveil-runtime.cjs" pnpm start
```

systemd·pm2 등을 쓴다면 해당 서비스의 환경변수 `NODE_OPTIONS`에 같은 값을 넣고 서버를 재시작합니다. 이미 `NODE_OPTIONS`를 쓰고 있다면 공백으로 이어 붙이세요.

## 업데이트

```bash
git -C /opt/me-loreveil pull
docker compose up -d --force-recreate marinara   # Docker 없이는 서버 재시작
```

## 확인

서버 로그(표준 오류)에 사이트별로 한 줄씩 나옵니다. 지연 로딩되는 사이트는 처음 쓰일 때 나중에 나타날 수 있습니다.

```text
[loreveil] applied: request-scan-scope
[loreveil] applied: prompt-regex-scan-view
[loreveil] applied: keyword-chat-and-pinned
[loreveil] applied: semantic-lorebook-query
[loreveil] applied: semantic-router-query
```

`applied` 다섯 줄이 모두 보이면 정상입니다. 다음 줄이 보이면 그 사이트만 적용되지 않은 것입니다.

```text
[loreveil] fail closed: keyword-chat-and-pinned (expected exactly one source anchor)
```

**fail closed**는 "그 사이트의 제외 기능을 끄고 Marinara의 원래 동작을 유지한다"는 뜻입니다. 서버가 깨지지는 않지만 해당 경로에서는 표시 안쪽 글도 다시 검색에 들어갑니다. 지원하지 않는 버전이거나 Marinara 코드가 달라져 패치할 위치를 정확히 한 곳 찾지 못할 때 생깁니다.

간단한 동작 확인법: 로어북 항목의 키워드를 `<loreveil>키워드</loreveil>` 안에만 넣은 메시지를 보냈을 때 그 항목이 켜지지 않고, 표시 밖에 같은 단어를 쓰면 켜지는지 봅니다.

## Clean HTML 정규식과 함께 쓰기

Marinara 기본 정규식 `Clean HTML (Outgoing Prompt)`는 프롬프트에서 HTML 태그를 지웁니다. 이 정규식은 **켜 둔 채로 쓰면 됩니다.**

ME-LoreVeil은 프롬프트에는 기존대로 `정규식(원문)`을, 검색에는 `정규식(제외 구간을 먼저 비운 원문)`을 씁니다. 예를 들어 `<div loreveil>Moonstone</div>`는 모델에게 `Moonstone`으로 전달되고 저장 원문에는 태그가 남지만, 검색에서는 빠집니다. 직접 만든 prompt/both 정규식이 표시를 지우거나 다른 태그로 바꿔도 같은 방식으로 처리됩니다.

## 알려진 한계

- **정규식 결과 대응.** 검색용 글은 "정규식 결과"를 기준으로 연결됩니다. 서로 다른 두 원문이 같은 정규식 결과를 내는데 검색 결과가 다르면, 그 문자열은 원래 검색으로 되돌아갑니다(로그: `fail closed: prompt-regex-scan-view (ambiguous regex output; original scan retained)`).
- **정규식 이후의 변형.** 정규식 뒤에 메시지 매크로가 다시 확장되거나, 그룹 채팅의 화자 접두사가 본문을 바꾸면 대응이 맞지 않아 제외가 보장되지 않습니다. 본문 전체를 다시 쓰는 확장을 함께 쓰면 직접 확인하세요.
- **안전 한도.** 한 요청에서 키 4,096개 또는 8,388,608 UTF-16 코드 단위를 넘거나 매크로 결과를 안전하게 재사용할 수 없으면, 그 요청의 **제외 기능만** 꺼집니다. 응답 자체에는 영향이 없습니다.
- 요청 문맥이 없는 내부 호출에서는 표시가 남아 있는 원문에 대해서만 제외가 동작합니다.
- 응답이 끝난 뒤 따로 도는 후처리(요청이 닫힌 뒤의 검색)는 정규식 결과 대응을 쓰지 못해, 위와 같이 표시가 남아 있는 원문에만 제외가 동작합니다.
- 공백 자체를 매칭하는 정규식 키워드는 활성화될 수 있습니다(제외 구간이 공백으로 바뀌기 때문).
- 지원 버전 밖(포크 등)의 동작은 보장하지 않습니다.

## 끄기·제거

- **임시로 끄기:** 환경변수 `LOREVEIL_DISABLED=1`을 주고 재생성(재시작)합니다. 런타임이 아무것도 패치하지 않습니다.
- **완전 제거:** `NODE_OPTIONS`에서 이 `--require`와 볼륨 마운트를 지우고 재생성(재시작)합니다. 저장된 메시지나 `dist`는 바뀐 적이 없으므로 복원할 것이 없습니다.

## 개발자용 테스트

로컬 서버나 실제 모델 없이 도는 기본 테스트입니다.

```bash
npm test
```

기억 모듈(아래 출처 참고)과 함께 로드되는지 보는 통합 테스트입니다. 기억 모듈의 `marinara-memory-runtime.cjs`를 임시 경로에 받아 지정합니다.

```bash
LOREVEIL_MEMORY_RUNTIME=<기억 모듈 런타임 경로> npm run test:integration
```

전체 HTTP E2E는 의존성을 설치하고 shared/server를 빌드한 Marinara 2.5.1 또는 2.5.2 디렉터리가 필요합니다. 실서비스를 건드리지 않도록 경로가 `/tmp/` 아래가 아니면 거부합니다. 가짜 OpenAI 호환 모델과 새 데이터 디렉터리, OS가 할당한 로컬 포트를 씁니다.

```bash
LOREVEIL_ENGINE_ROOT=<빌드한 Marinara 경로> \
LOREVEIL_MEMORY_RUNTIME=<기억 모듈 런타임 경로> \
LOREVEIL_CLEAN_HTML=on LOREVEIL_ORDERS=first,last LOREVEIL_DISABLED=0 \
  npm run test:e2e
```

| 변수 | 설명 |
|---|---|
| `LOREVEIL_ENGINE_ROOT` | 빌드한 Marinara 경로 (`/tmp/` 아래) |
| `LOREVEIL_MEMORY_RUNTIME` | 기억 모듈 런타임 파일 경로 (`/tmp/` 아래) |
| `LOREVEIL_CLEAN_HTML` | `on`(기본) / `off`: 태그를 남기는 변형 |
| `LOREVEIL_ORDERS` | 두 런타임의 로드 순서. `first,last`(기본), `none`은 기억 모듈만 로드하는 대조군 |
| `LOREVEIL_DISABLED` | `1`이면 제외가 꺼져 내부 키워드가 다시 켜지는지 보는 대조군 |

실행 결과(`evidence.json`, 가짜 모델이 받은 요청, 서버 로그)는 `/tmp/loreveil-e2e-*`에 남습니다.

## 라이선스·출처

AGPL-3.0-only입니다. 전문은 [LICENSE](LICENSE), 파서 출처와 제3자 고지는 [NOTICE](NOTICE)에 있습니다. 로드 훅 구조는 [tlsiddl/marinara-memory-module](https://github.com/tlsiddl/marinara-memory-module)(MIT)을 참고했고, 이 기억 모듈과 함께 로드해도 되는지 테스트했습니다. 테스트 자료에는 [Pasta-Devs/Marinara-Engine](https://github.com/Pasta-Devs/Marinara-Engine)(AGPL-3.0)에서 변환한 코드가 들어 있습니다.
