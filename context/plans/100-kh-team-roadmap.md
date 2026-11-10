# kh-team — Roadmap

Fork của [jsm-hq](https://github.com/jsmastery-pro/jsm-hq) (MIT; remote `upstream`). Mục tiêu: một "văn phòng" AI agent chạy được trên internet, mỗi văn phòng làm việc độc lập trên một repo GitHub, agent dùng được nhiều mô hình (Claude, GPT, Gemini, DeepSeek, OpenRouter, Ollama) qua subscription hoặc API key.

## Quyết định đã chốt (2026-11-08)

| # | Chủ đề | Quyết định |
|---|---|---|
| 1 | Nền tảng | Fork jsm-hq, giữ `upstream` để lấy bản sửa lỗi. Phải đổi tên và branding trước khi phát hành (xem `TRADEMARKS.md`). |
| 2 | Người dùng | Nhiều người dùng, chạy hosted trên internet. |
| 3 | Provider | Anthropic, OpenAI, Google Gemini, DeepSeek, OpenRouter, Ollama. |
| 4 | Model theo agent | Mỗi agent chọn `cli` + `auth` + `provider` + `model` riêng. Reviewer có thể dùng model khác với người viết code. |
| 5 | Chỗ chạy | **Mọi agent chạy trong Docker Sandbox riêng** (bắt buộc, không còn Local mode), kể cả agent dùng API key. Chốt ngày 2026-11-08. |
| 6 | Git | Bắt buộc GitHub; mỗi task là một PR `[TASK-ID] …`. |
| 7 | Giao diện | Dashboard web. Sau này: nhiều văn phòng, mỗi văn phòng một repo, chạy độc lập; chỉ cần đưa repo + mục tiêu cho lead là cả team tự làm. |
| 8 | Merge | Cấu hình được (`workflow.merge.by`), mặc định chỉ người dùng merge. |
| 9 | Ngân sách | Cấu hình được, mặc định 10 USD mỗi văn phòng mỗi ngày. Chỉ tính agent dùng API key (subscription không có chi phí theo USD). |
| 9b | Giới hạn subscription | Khi Claude/Codex chạm giới hạn 5 giờ hoặc tuần: **chờ reset**, không tự chuyển sang API key. Hạn mức tính theo tài khoản (mọi agent dùng chung một đăng nhập bị chặn cùng lúc). |
| 10 | Quy mô | 3–4 agent mỗi văn phòng; thêm hoặc xoá agent được. |
| 11 | Ngôn ngữ | Prompt và ROLE.md bằng tiếng Anh; giao diện và thông báo bằng tiếng Việt. |

## Mô hình truy cập model

| CLI | Subscription | API key |
|---|---|---|
| Claude Code | Claude Pro/Max (đăng nhập trong terminal của agent) | Anthropic; DeepSeek và OpenRouter qua `ANTHROPIC_BASE_URL` |
| Codex | ChatGPT (đăng nhập trong terminal) | OpenAI (`forced_login_method = "api"`) |
| OpenCode (2.x, bản sbx cài sẵn) | — | Anthropic, OpenAI, Gemini, DeepSeek, OpenRouter, Ollama trên máy này |

- **Không bao giờ** trích xuất OAuth token của subscription để gọi API trực tiếp. Subscription chỉ dùng qua CLI chính chủ, người dùng tự đăng nhập.
- Khi chạy hosted cho nhiều người: mỗi người dùng tự mang key của mình (BYOK). Trước khi bật subscription cho người dùng khác, cần kiểm tra điều khoản hiện hành của từng nhà cung cấp; mặc định hosted chỉ dùng API key, subscription dành cho bản tự host.
- Gemini CLI đã bị thay bằng Antigravity CLI cho gói miễn phí và Google One (theo geminicli.com, từ 2026-06-18). Vì vậy Gemini hiện đi qua OpenCode với API key; adapter cho Gemini subscription để sau.

## Các giai đoạn

### P0 — Fork và đa provider (đang làm, plan 101)
Fork, build gốc, thêm `auth`/`provider`, adapter OpenCode chạy trong sandbox (Pi được thử rồi bỏ vì sbx không có sẵn Pi), file key của văn phòng, mọi agent chạy sandbox riêng. Node quản lý bằng nvm (`.nvmrc` = 22).

### P1 — Hoàn thiện văn phòng đơn
- Đổi tên và branding (`kh-team`), đường dẫn `~/.kh-team/`, tên gói npm.
- Giao diện tiếng Việt (i18n, giữ tiếng Anh làm dự phòng).
- Theo dõi chi phí: OpenCode (sự kiện `session.step.ended` có `cost` và `tokens`), Claude Code (JSON của `statusLine` có `cost.total_cost_usd`), Codex (cần tìm hiểu). Ngân sách mặc định 10 USD mỗi văn phòng mỗi ngày (reset 0h theo giờ máy chủ): cảnh báo ở 80%, dừng agent dùng API key ở 100%, tạo Action item.
- Giới hạn subscription (chờ reset):
  - Phát hiện: Claude Code qua hook `StopFailure` (matcher `rate_limit`) và `rate_limits.five_hour`/`seven_day` (`used_percentage`, `resets_at`) trong JSON của `statusLine`; Codex qua câu "You've hit your usage limit" trên màn hình; OpenCode qua `session.execution.failed` → hook `StopFailure` (đã có).
  - Trạng thái `rate-limited` theo tài khoản, kèm giờ reset, hiện trên dashboard; cảnh báo khi một cửa sổ chạm 80%.
  - Khi bị chặn: giữ tin nhắn trong inbox, báo lead không giao việc cho các agent đó; đến `resets_at` thì tự nhắn agent làm tiếp task dở.
- Review chéo: thêm công cụ review "agent" để một agent Reviewer (model khác) review PR bằng `gh pr review`.
- Key qua proxy của sbx (`sbx secret set <dịch vụ> --sandbox <tên>`) cho Anthropic/OpenAI/Gemini/OpenRouter, để key không vào máy ảo; DeepSeek vẫn phải qua biến môi trường.
- Session bền hơn:
  - **Lưu inbox xuống đĩa** (`~/.jsmhq/<slug>/inbox.json`, ghi kiểu atomic). Hiện queue chỉ nằm trong RAM (`server/inbox.ts`), nên HQ tắt là mất tin nhắn đang chờ. Khi HQ khởi động lại thì nạp lại queue và giao tiếp khi agent rảnh.
  - **Resume hội thoại khi start lại agent.** Hiện Stop rồi Start luôn mở hội thoại CLI mới (lịch sử vẫn còn trong VM vì `sbx stop` không xoá). Thêm lựa chọn "Tiếp tục hội thoại cũ" (mặc định bật). Claude Code dùng `--continue`, Codex dùng `resume --last`, OpenCode cần tìm hiểu cách tiếp tục session 2.x. Sau "Recreate sandbox" hoặc khi resume lỗi thì mở hội thoại mới và gửi cho agent tóm tắt task đang làm.

### P2 — Chế độ tự động
- Ô "Mục tiêu" cho văn phòng: lead lập board, tự giao việc, tự tiếp tục khi có agent rảnh.
- Giới hạn an toàn: ngân sách, số task tối đa, dừng khi bị chặn quá lâu, báo cáo cuối ngày.

### P3 — Nhiều văn phòng trong một server
- Tách `Hub`/`Planner`/`Sessions`/`Sbx`/`GitHubSync` thành một lớp `Office`; server quản lý nhiều `Office`, route `/o/:officeId`.
- Tạo văn phòng từ URL repo GitHub (clone vào thư mục của văn phòng).
- Mỗi văn phòng có token, port của agent, file key và ngân sách riêng.
- Trình quản lý văn phòng: một server, một port, danh sách văn phòng với trạng thái từng văn phòng, tạo/mở/dừng văn phòng trên giao diện. Thay cho cách hiện tại là mỗi văn phòng chạy một lệnh `jsm-hq --repo … --port …` riêng.
- Mã văn phòng hiện lấy từ tên repo (`slugify(repo.name)`). Hai repo trùng tên (khác owner) sẽ đụng nhau ở `~/.jsmhq/<slug>/` và tên tmux/sandbox `hq-<slug>-<agent>`, nên mã cần gồm cả owner (hoặc một id riêng).

### P4 — Hosted, nhiều người dùng
- Đăng nhập bằng GitHub OAuth; người dùng, tổ chức, thành viên của văn phòng và quyền (xem, điều khiển, quản trị).
- Cơ sở dữ liệu (SQLite rồi Postgres) thay cho file JSON; kho secret mã hoá khi lưu.
- HTTPS qua reverse proxy, xác thực WebSocket, phân quyền truy cập terminal, audit log.

### P5 — Cô lập khi hosted
- Mỗi văn phòng hoặc agent chạy trong container (Docker, gVisor/Firecracker) có giới hạn CPU, RAM và mạng.
- HQ nối tới agent qua mạng container (hook HTTP từ plugin của OpenCode và hook của Claude/Codex); key được đưa vào qua proxy để không lọt vào container.

### P6 — Vận hành
Triển khai (VPS hoặc Fly), giám sát, sao lưu, rate limit, cập nhật CLI agent.
