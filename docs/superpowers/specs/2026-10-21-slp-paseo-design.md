# SLP trên Paseo — Design spec

- Ngày: 2026-10-21 (rev 2: 2026-10-22, gộp kết quả spike; rev 3: 2026-10-22, sửa theo review độc lập; rev 4: 2026-10-22, mỗi feature một Supervisor + nhịp kiểm)
- Trạng thái: draft rev 5.10, chờ anh duyệt
- Paseo đã kiểm: 0.12.0 đang chạy (source v0.10.3 + v0.12.0, CLI, và probe live — xem [`docs/research/spikes-2026-10-21.md`](../../research/spikes-2026-10-21.md))
- Superpowers đang cài: 6.4.1
- Nền: báo cáo "Tinh túy Superpowers và SLP" (2026-10-09), spec SLP cũ `~/.agents/skills/slp/docs/spec.md` (không có Supervisor), mining transcript + git 2026-09-21 → 10-20, ghi chú [`docs/research/paseo-capabilities-verified.md`](../../research/paseo-capabilities-verified.md).
- Rev 3 sửa theo review độc lập ngày 2026-10-22 (bản đầy đủ nằm ở thư mục ghi chú chung của các session, `review-spec-plan-fable-2026-10-22.md`):
  - worktree do Paseo tạo;
  - git dir tin cậy và file hook được bảo vệ;
  - tin của anh được ghi ngay trong turn;
  - token chỉ lưu dạng hash;
  - `toolPolicy` thay cho tự duyệt;
  - bỏ `slp_permit`;
  - task resolve conflict qua `merge_base`.
- Rev 4 (anh chốt 2026-10-22):
  - mỗi feature một Supervisor thay cho một Supervisor mỗi project;
  - plugin giữ chủ contract giữa các feature;
  - nhịp kiểm 15 phút: Supervisor xem Lead và Peer của feature mình (§7.7);
  - lỗi nhỏ từ review: m1, m7, m9, m11, m12, m13, m17.
- Rev 5 (2026-10-22, sửa theo review Codex `gpt-6-astra` và report human attention):
  - (thay ở 5.2) worktree của SLP do plugin tạo, hook tắt, dưới `~/.slp-worktrees`, mỗi cái một workspace `directory`: Paseo không chạy `worktree.setup`, `teardown` hay hook `post-checkout` của repo cho agent SLP (§4, §7);
  - kiểm quote: tin mới nhất quyết định, cổng duyệt cần một câu "đồng ý" thuần, mỗi tin chỉ đứng sau một quyết định (§7.6);
  - nghiệm thu: review chỉ tính sau khi turn reviewer kết thúc sạch và `verdict = pass`; merge đúng commit đã verify; không accept khi worktree còn thay đổi chưa commit; evidence không xanh nếu verify làm đổi file tracked (§7.1);
  - spawn: tuần tự theo project, kiểm phụ thuộc, Peer mới tiếp quản task của Peer đã chết trong workspace cũ (§7.4);
  - challenge vào D#/H#/contract luôn ở mức spec; contract chờ nhau thành vòng bị từ chối; đổi goal dừng hẳn feature (§6.4, §6.5);
  - Lead thấy status và nội dung báo cáo của Peer (§5.2);
  - (5.3) repo có git filter `clean`/`smudge`/`process`, merge driver hay `textconv` trong config (trừ `git-lfs`) thì SLP không chạy agent và không commit report, vì `git add`/`git status` sẽ chạy chúng ngoài sandbox; tạo agent hỏng thì gỡ đúng worktree và branch vừa tạo; plugin chỉ gỡ worktree qua git; (5.4) `git-lfs` chỉ được miễn khi khớp nguyên văn, và config được kiểm trong chính worktree mới trước khi checkout (config có thể phụ thuộc branch qua `includeIf onbranch:`); (5.5) `fetch`/`push`/`gh` chạy ở checkout chính; cổng ship cần brief, spec, plan hiện tại đều đã duyệt và `slp_ship` kiểm lại blocker ngay trước khi push; resume không bao giờ cắt ngang turn đang chạy;
  - round 2–3 của review: evidence gắn với định nghĩa task (A→B→A vẫn đúng) và stale lan sang task phụ thuộc; Peer tiếp quản giữ commit đã có; ở cổng duyệt mọi mệnh đề của tin phải là câu đồng ý thuần; resume gửi một lượt mỗi tick, hỏng thì lùi, không chặn job khác; evidence chỉ xanh khi chạy đúng commit nó ghi.
- Rev 5.6 (2026-10-23): chốt model mặc định từng vai (Supervisor và Lead Opus 5.5, Peer-impl Sonnet 5.5, Peer-review `gpt-6-astra`) và `models.allowed` (§2, §8).
- Rev 5.7 (2026-10-23, học từ `codex-room-setup` của hoangnb24 rồi probe trên máy, S11): vai SLP không nạp setting của anh hay của repo nữa, vì hook trong `.claude/settings.json` của checkout chạy ngoài sandbox và `.mcp.json` tự khởi động server; `.claude/`, `.codex/`, `.mcp.json` thành file được bảo vệ như hook git; vai Codex có `CODEX_HOME` riêng (§4, §7.1, §8, §12). Sonnet 5.5 cần Claude Code ≥ 2.1.284 (§8).
- Rev 5.8 (2026-10-23, luật giao tiếp học từ `codex-room-setup` và `paseo-supervision`): mỗi report của Peer phải được Lead đóng bằng một quyết định, gói kiểm hiện report đang chờ; report có mẫu 4 nhóm và `blocked` nói rõ loại; task có `outcome`; Supervisor can thiệp bằng một quan sát và một câu hỏi mở, giữ item mở tới khi đóng có lý do, coi dữ liệu thiếu là khe quan sát; quyết định xong thì đi tiếp; không subagent có sẵn, không Ultra Code (§4, §6.3, §6.5, §6.6, §7.7).
- Rev 5.9 (2026-10-23, sau lượt chạy live T21, bằng chứng ở [`docs/research/smoke-2026-10-23.md`](../../research/smoke-2026-10-23.md)):
  - Luồng đầu (anh chốt):
    - brainstorm với anh là bước kỹ nhất;
    - câu khó thì Supervisor gọi Lead vào tham vấn từ trước mọi cổng;
    - Supervisor, Lead và anh tranh luận tới spec;
    - **bỏ cổng brief**, chỉ còn 2 cổng của anh là spec và ship (§2, §4, §6).
  - Bảo mật:
    - mọi vai SLP tắt hẳn Paseo tools, vì tool `paseo` không qua permission nên terminal, schedule và `set_agent_mode` là đường thoát sandbox (B-3);
    - tin phát lại sau `agent reload` không được ghi là tin của anh (B-4);
    - sandbox của reviewer Codex và của runner verify chặn đọc `~/.slp`, `~/.paseo`;
    - rủi ro còn lại của reviewer Codex được anh chấp nhận cho pilot (§4, §7.1, §13).
  - Công chú ý của anh:
    - plugin tự cho shell trong sandbox của vai Claude, và cho đọc trong repo cùng worktree SLP (B-8);
    - workspace của SLP nằm dưới project của repo, workspace Peer và reviewer chạy nền (B-9) (§7.1, §7.4).
  - Sửa vận hành:
    - đọc lại agent profile mỗi lần tạo agent (B-1);
    - Lead không nhận `model` (B-2);
    - báo commit đúng một lần (B-5);
    - nhãn reviewer (B-6);
    - không nhắc báo cáo ở turn do anh mở (B-7);
    - timer chạy sau khi reload plugin (§7.1, §7.7, §9).
  - Sửa theo review Codex của spec + plan (2026-10-23):
    - premise nào cũng chỉ ràng buộc sau khi anh duyệt spec liệt kê nó, kể cả premise của Supervisor (§5.2);
    - reviewer Codex không mang `modeId`/`sandbox_mode` để profile chặn đọc có hiệu lực (§4);
    - mọi tin anh nhắn Lead đều báo Supervisor (§6.1, §7.1);
    - báo một lần theo (report, kết quả xử lý), cả cho report `blocked` và report bị từ chối; wake không tự chạy tick (§7.1);
    - gỡ các đoạn cũ còn ghi `-P :workspace` và cấm worktree cho repo có setup (§2, §7).
- Rev 5.10 (2026-10-24, sau lượt smoke lại, bằng chứng ở [`docs/research/smoke-2026-10-23-rerun.md`](../../research/smoke-2026-10-23-rerun.md)):
  - Mỗi `slp_brief` là ảnh chụp đầy đủ các premise của bản ghi: premise giữ id qua các version, premise do brief cũ tạo mà vắng ở brief mới thì bị gạch (F1: 10 brief thành 47 premise cho 11 quyết định, duyệt spec bật nhầm D1, D36) (§5.2, §5.3, §6.1).
  - Plugin gắn lại env của vai mỗi lần Paseo mở phiên, vì Paseo không lưu env override (F6: reload làm mất reviewer Codex, vai Claude mất cờ CLAUDE.md) (§7.1).
  - Ngôn ngữ (anh chốt): agent viết cho anh bằng ngôn ngữ của tin mới nhất của anh; brief, spec, plan, report và tin giữa các vai bằng tiếng Anh. Supervisor trình spec bằng ngôn ngữ của anh (F2) (§6, §6.2).
  - Digest và gói kiểm dễ đọc: bỏ dòng rỗng, việc chờ anh lên đầu, premise chờ duyệt chỉ hiện tới khi spec được duyệt, mỗi cái một dòng (§5.4, §7.7).
  - Câu nhắc báo cáo nêu đúng tool của vai (F4); `ship.openPr: false` thì Supervisor không hứa mở PR (F7) (§6.7, §7.1).
  - Vai Claude không có tool `AskUserQuestion` (thẻ câu hỏi của Paseo): câu trả lời trên thẻ không thành tin nhắn nên plugin không ghi được lời anh (G1, smoke rev 5.10) (§4).

**Core mechanism:** mỗi ý tưởng anh mở một Supervisor → Supervisor brainstorm với anh (câu khó thì gọi Lead vào tham vấn; hai agent và anh tranh luận) → Lead viết spec từ bản ghi brainstorm (anh duyệt) và plan (Supervisor duyệt) → Lead giao từng task cho Peer-impl trong worktree riêng, trong sandbox → mọi tin nhắn, báo cáo, challenge đi qua tool MCP của plugin `slp`; plugin kiểm quyền, ghi log append-only ngoài repo, commit thay Peer, chạy verify trong sandbox, tự resume khi dính limit, mỗi 15 phút gửi Supervisor một gói kiểm → Supervisor gom ship, anh duyệt đúng commit hash → push + PR → anh merge.

**Decisions:**
- Supervisor là agent Paseo độc lập, đầu mối chính của anh; lo cả vận hành lẫn tiền đề/mục tiêu.
- Plugin chủ yếu chạy trên server (cảm biến + tay chân + người gác cổng); phần client chỉ dùng để đánh thức timer và cho view trace; phán đoán để cho agent (rev 5.9).
- 1 Supervisor + 1 Lead / feature, nhiều feature song song, writer tuần tự trong mỗi feature. Supervisor đọc được digest của feature khác (chỉ đọc). Contract chung: feature được duyệt plan trước giữ contract; không xếp được thì hỏi anh.
- Giám sát: mỗi 15 phút plugin gửi Supervisor một gói kiểm do plugin dựng (không phải transcript); Supervisor phán ổn / theo dõi / can thiệp; can thiệp Peer luôn đi qua Lead.
- Anh giữ: brainstorm (bước kỹ nhất), spec, ship (theo commit hash), merge, mọi đổi goal/cost/tiền đề. Không có cổng brief (rev 5.9).
- State nằm ở `~/.slp/<project>/`, plugin là writer duy nhất.
- Feedback ngược lên là quyền có cổng bằng chứng (challenge), cộng kênh hỏi không chặn (`slp_ask`).
- Peer-impl = Claude trong sandbox của Claude Code; Peer-review = Codex. Model mặc định: Supervisor và Lead Opus 5.5, Peer-impl Sonnet 5.5, Peer-review `gpt-6-astra`; đặt trong agent profile, đổi một chỗ (§8).
- Peer không commit; plugin commit thay Peer (hook tắt). Plugin không bao giờ chạy code do Peer viết ở ngoài sandbox.

**System impact:**
- Anh làm việc trong Paseo app (desktop/mobile), không trong Claude app, cho các feature chạy SLP.
- Mỗi ý tưởng anh mở một Supervisor mới (profile `slp-supervisor`, workspace thư mục gốc của project), nên mỗi feature có một tab Supervisor riêng. Khi feature đang chạy, tab đó nhận tối đa 4 lượt kiểm mỗi giờ; lượt ổn chỉ một dòng.
- Mỗi Lead, Peer, reviewer chạy trong một worktree do plugin tạo (`~/.slp-worktrees/<project>/<branch>`, hook tắt), gắn với một workspace `directory` thuộc **project của repo** (`projectId`). Sidebar chỉ có thêm một dòng `[Lead] <slug>` mỗi feature, nằm dưới project. Workspace của Peer và reviewer chạy nền (`background`), không hiện trong sidebar. Khi task xong, plugin archive agent và workspace rồi gỡ worktree, giữ branch (rev 5.9).
- Shell của vai Claude chạy trong sandbox thì plugin tự cho; đọc file trong repo và trong worktree SLP của project cũng tự cho. Chỉ permission còn lại mới chờ anh trong app: đọc ngoài các vùng đó, và những gì plugin không biết. Mục tiêu là không có popup shell nào (rev 5.9).
- Thay đổi ở thư mục hook (`.husky/`, `.githooks/`, `core.hooksPath`), `paseo.json` và setting agent trong repo (`.claude/`, `.codex/`, `.mcp.json`) không bao giờ được plugin commit; muốn đổi thì anh làm tay.
- Agent SLP không nhận hook, MCP server, plugin, connector claude.ai và CLAUDE.md toàn cục của anh; chỉ có Superpowers và MCP `slp` (rev 5.9: không còn MCP `paseo`). CLAUDE.md của repo vẫn được đọc.
- Daemon Paseo bật `pluginsEnabled` (code không sandbox chạy trên máy anh) — chỉ bật khi anh đồng ý ở bước triển khai.
- `~/.paseo/config.json` thêm 4 provider ID theo vai, cả bốn tắt hẳn Paseo tools (`paseoTools.enabled: false`). Nếu provider `slp-*` nào còn bật thì plugin không tạo agent SLP (rev 5.9).
- Thêm thư mục `~/.slp/`. Repo của project không chứa file SLP nào.
- Agent SLP không tự push được; push/PR chỉ qua cổng ship.
- Commit trên branch task do plugin tạo (author = identity git của anh, trailer `SLP-Task`, `SLP-Agent`); git hook của repo không chạy lúc commit mà chạy trong sandbox như một phần của verify.

## 1. Mục tiêu

Anh đang là "keo người" của một pipeline nhiều agent. Số liệu một tháng (2026-09-21 → 10-20, 154 session):

| Toil | Số liệu |
|---|---|
| Duyệt suông ("đồng ý", "A", "commit", "ok viết plan đi") | 516 prompt ≤ 15 ký tự (19%) |
| Hỏi tiến độ / treo ("còn chạy không", "sao dừng") | 23 prompt / 15 session |
| Dừng vì usage/rate limit | 33 lần + 16 lần "Try again" + 7 lần "hit limit… continue" |
| Claim "xong" sai, chẩn đoán sai | ~25 ca rõ |
| Rào scope trước ("chỉ brainstorm", "đừng push") | ~49 session |
| Lẫn worktree / branch, commit nhầm chỗ | nhiều lần |
| Merge main → resolve conflict | ~40 prompt gần như giống hệt / 22 session |
| Compaction | 394 (228 gõ tay) |

Và một ca tiền đề sai kéo dài: Owner Assistant (huskit) mất 8–12 ngày từ bằng chứng ngược (09-25) tới quyết định đổi (10-08/09), xoá ~15k dòng — vì giả thuyết P3/P4 bị chép tiếp thành ràng buộc.

Harness này phải:
1. **Thay anh làm Supervisor**: anh dồn sức vào brainstorm, duyệt 2 cổng (spec, ship), trả lời leo thang thật. Popup permission cho lệnh shell trong sandbox không tính là việc của anh (rev 5.9).
2. **Giữ SLP**: một owner mỗi scope; quyền chất vấn tách quyền sửa; chất vấn có bằng chứng; đổi hướng đi qua shared state của Lead; goal/cost/tiền đề về tay anh.
3. **Cưỡng chế bằng cơ chế** (plugin, sandbox, provider policy), không chỉ bằng prompt.
4. **Tự chứng minh giá trị**: mỗi cơ chế đo được, tắt được.

Không gắn với project nào. Lần chạy đầu: một project mới, anh định nghĩa sau.

## 2. Quyết định đã chốt

| Chủ đề | Chọn | Lý do |
|---|---|---|
| Nền | Paseo 0.10.x, làm việc trong Paseo app | Tác giả SLP chạy trên Paseo; chỉ agent Paseo mới có plugin hook, heartbeat, thông báo |
| Supervisor | Agent LLM độc lập, lo cả vận hành (A) và tiền đề/mục tiêu (B); phần máy móc do plugin làm hộ | Anh muốn Supervisor thay anh; "cheapen mechanics, never judgment" |
| Tương tác của anh | Chủ yếu brainstorm với Supervisor. Câu khó thì Supervisor gọi Lead vào cùng nghĩ, và anh tranh luận thẳng với Lead được. Thỉnh thoảng anh nhắn Peer | Đổi hướng ở Lead/Peer phải được ghi vào state. Brainstorm kỹ là chỗ duy nhất ý anh vào hệ thống; từ spec trở đi agent chỉ làm theo cái đã chốt (rev 5.9) |
| Cổng của anh | Spec (điểm kết của brainstorm) và ship (theo commit hash); merge luôn do anh. **Không có cổng brief** (rev 5.9) | Smoke T21: phỏng vấn nông (1–2 câu, Supervisor tự chọn D2/D3), Lead không chất vấn brief, còn câu "duyệt" spec không bắt được gì (mâu thuẫn trong spec là reviewer tìm ra). Vì vậy dồn công chú ý vào một buổi brainstorm kỹ. Supervisor duyệt plan trở xuống |
| Ship | Gom một lần cuối feature: diff tóm tắt, bằng chứng chạy lại trên đúng commit, rulings, giả thuyết còn mở | Một lần duyệt có bằng chứng thay cho nhiều "commit"/"ok" |
| Kiến trúc | Plugin chủ yếu server + file state + prompt theo vai. Rev 5.9: thêm phần client nhỏ (RPC "wake" cho timer; view trace theo spec riêng) | Phương án 2/3. T21: timer chết sau reload khi không có hook nào, và anh không lần ra một feature qua cả chục tab |
| Số Supervisor | 1 / feature: anh mở một Supervisor cho mỗi ý tưởng; nó gắn với feature từ brief v1 và chỉ tạo một Lead. Đọc digest feature khác (chỉ đọc). Contract chung: plan duyệt trước giữ contract (§7.1 Giữ contract); không xếp được thì hỏi anh. Xoay vòng khi context đầy | Một Supervisor chung cho cả project trộn chat của anh với sự kiện của mọi feature; một câu "duyệt" khớp mọi cổng đang chờ (kiểm quote chỉ lọc theo agent và thời gian); phỏng vấn của nhiều feature dồn vào một context. Phần thật sự xuyên feature (so touch set, chủ contract) plugin làm được |
| Giám sát | Mỗi `watch.intervalMinutes` (15) plugin gửi Supervisor một gói kiểm về Lead và Peer của feature; Supervisor phán ổn / theo dõi / can thiệp (§7.7) | Anh đã gặp agent quay vòng/overthink và đi sai hướng, phát hiện muộn; phán đoán để Supervisor, plugin chỉ gom số liệu |
| Song song | Nhiều feature song song (mỗi feature 1 Lead, 1 worktree); writer tuần tự trong feature | Scope tách rời thật mới song song |
| State | `~/.slp/<project>/`, append-only JSONL, plugin là writer duy nhất | Bền qua run; không để dấu vết trong repo |
| Feedback ngược | Challenge có bằng chứng ở mọi tầng + `slp_ask` không chặn | Lõi khác biệt của SLP |
| Pilot | Project mới, anh định nghĩa sau; **không làm replay** | Anh chốt |
| Model | Supervisor `claude-opus-5-5` `high`, Lead `claude-opus-5-5` `xhigh`, Peer-impl `claude-sonnet-5-5` `high`, Peer-review `gpt-6-astra` `xhigh`, đặt trong Paseo agent profile của từng vai (§8). Lead nâng model cho từng task trong danh sách anh cho phép (`models.allowed`), Supervisor duyệt khi duyệt plan | Plan sai thì mọi Peer làm sai theo, nên Lead mạnh nhất; Supervisor duyệt plan nên không yếu hơn Lead; Peer là vai đông nhất và có verify + review kiểm sau; reviewer là chốt độc lập duy nhất trước accept. Anh đổi model một chỗ |
| Vendor | Supervisor, Lead, Peer-impl = Claude; Peer-review = Codex. Đổi được qua `extends`; ràng buộc: reviewer khác vendor với implementer. Rev 5.9: anh chọn giữ reviewer Codex cho pilot trên repo của anh (T21 dòng 19, phương án c), kèm chặn đọc theo §4 | Sandbox Claude do plugin gắn chặn được cả localhost (S10a). Codex chạy qua Paseo: S3 thấy localhost mở, T21 đo được bị chặn (`000`), nhưng nó đọc được `~/.paseo` và `~/.slp` (§13) |
| Commit | Peer không commit; plugin commit thay Peer lúc `slp_report`, luôn tắt hook | Sandbox giữ `.git` chỉ đọc (Codex cố ý, S9); plugin biết chắc commit hash để verify/review/merge |
| Chạy code của Peer | Plugin chạy verify và hook của repo **trong sandbox** (`codex sandbox -P slp-verify`, profile kế thừa `:workspace` và chặn đọc `sandbox.denyRead`; rev 5.9), không bao giờ ngoài sandbox | Hook/test do Peer sửa sẽ chạy với toàn quyền nếu plugin chạy trực tiếp (S10) |
| Worktree | Plugin tạo (`git worktree add`, hook tắt) dưới `~/.slp-worktrees`, rồi `workspaces.create({ source: { kind: "directory", path, projectId } })` và tạo agent trong workspace đó (rev 5.2). Rev 5.9: `projectId` là project của repo; Peer và reviewer thêm `background: true` | Có `parent` mà không có workspace thì Paseo ghi đè `cwd` của con bằng `cwd` của cha; worktree do Paseo tạo thì Paseo chạy `worktree.setup`, `teardown` và hook `post-checkout` của repo ngoài sandbox. Không có `projectId` thì Paseo tạo một project mới cho mỗi đường dẫn worktree, và project đó còn lại sau khi archive (T21: 6 project rác cho 2 feature, mỗi feature 1 task) |
| Git của plugin | Mọi lệnh tắt hook và fsmonitor, `--git-dir` lấy từ common dir của repo; không tin `<worktree>/.git`; không commit hook/`paseo.json`/setting agent (`.claude/`, `.codex/`, `.mcp.json`); plugin tự tạo worktree với hook tắt, ngoài `~/.paseo/worktrees`, nên Paseo không chạy setup/teardown/terminals của `paseo.json` hay hook `post-checkout` cho agent SLP (rev 5.2, §7) | Peer ghi được `<worktree>/.git` và nội dung commit; Paseo tự chạy `post-checkout` và `worktree.setup` của `paseo.json` khi tạo worktree, ngoài sandbox |

## 3. Phạm vi

**Trong v1:**
- Plugin Paseo `slp` (phần server với các thành phần ở §7; phần client chỉ có RPC "wake", rev 5.9).
- 4 file prompt vai (Supervisor, Lead, Peer-impl, Peer-review).
- Mẫu provider ID cho `~/.paseo/config.json` và `~/.slp/config.json`.
- Format brief / spec / plan (§6).
- Unit test plugin, 2 kịch bản áp lực cho prompt Peer, các kiểm tra còn mở ở cuối §11.1.

**Để sau (cần số liệu pilot):** plugin tự cảnh báo theo ngưỡng (không chờ nhịp kiểm); agent "watcher" riêng nếu lượt kiểm làm rối tab Supervisor; một Supervisor nhìn toàn project hay xuyên project; Hub/Slack.

**Spec riêng (rev 5.9):** view trace trong app. Một view theo chuỗi feature → phase → task → lần thử → agent (bấm để mở), kèm quyết định của anh, commit, evidence và timeline đọc từ `events.jsonl`. Vì workspace của Peer chạy nền, view này là chỗ mở Peer khi cần. View có spec và cổng duyệt riêng, không nằm trong v1 này.

**Không làm:**
- Không sửa plugin Superpowers. Superpowers vẫn là lõi bằng chứng tầng code bên trong Lead/Peer (TDD, verification, review theo `BASE..HEAD`).
- Không cho nhiều Peer-impl cùng sửa trong một feature.
- Không cho agent nhắn nhau ngoài router.
- Không replay lịch sử huskit.
- Không dùng SLP cho việc nhỏ, CRUD rời rạc, UI cần cảm nhận — những việc đó chạy như bình thường ngoài SLP.

## 4. Vai, quyền và cây agent

```
Anh ──brainstorm──► Supervisor A (1 / feature, anh mở cho mỗi ý tưởng, xoay vòng được)
  ╎ tranh luận / hỏi thẳng │ slp_spawn (đúng 1 Lead; gọi được ngay khi gặp câu khó, trước mọi cổng)
  ├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌► Lead A (worktree feat/<slug>; tham vấn → spec → plan → điều phối)
  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌► Peer     │ slp_spawn
                          ├─ Peer-impl (1 task / worktree con, tuần tự)
                          └─ Peer-review (worktree dùng-một-lần tại commit cần review)
Anh ──chat──► Supervisor B → Lead B …, Supervisor C → Lead C … (song song)
Supervisor đọc digest của nhau (chỉ đọc); không nhắn nhau
```

| Vai | Sở hữu / tự quyết | Đẩy lên | Không được |
|---|---|---|---|
| **Anh** | Goal, ưu tiên, ngân sách; brainstorm; duyệt spec, ship; merge | — | — |
| **Supervisor** | Một feature: brainstorm với anh (§6.1), ghi bản ghi brainstorm (brief, không có cổng); câu khó thì gọi Lead vào tham vấn và đứng về phía ý anh trong tranh luận (trích lời anh); đối chiếu spec với bản ghi trước khi trình anh; duyệt plan; xem touch set của feature khác (đọc digest); giám sát Lead và Peer qua nhịp kiểm (§7.7), gỡ kẹt qua Lead; phân loại leo thang; đọc kết quả kiểm bằng chứng trước ship; chuẩn bị gói ship; `feature_record` | Đổi goal / cost / tiền đề brief–spec, thứ tự giữa các feature → anh | Sửa code; nhắn hay steer Peer (đi qua Lead); ghi vào feature khác; tự duyệt spec/ship thay anh; tự chốt thay anh một điểm đáng hỏi trong brainstorm (điểm tự chọn phải ghi "tự chọn") |
| **Lead** | Tham vấn trong brainstorm khi được gọi: đọc repo, chạy thử trong sandbox, đề xuất hướng, phản biện có bằng chứng (đứng về phía tính khả thi); viết spec (khoá contract) và plan; sở hữu shared state của feature; chia scope; nhận/bác challenge mức plan bằng bằng chứng; ra ruling R#; integration, nghiệm thu; quyết định merge (plugin thực hiện merge vào `feat/<slug>` và merge main vào branch, hook tắt) | Challenge chạm brief/spec, vượt ngân sách → Supervisor | Sửa trong scope đang giao cho Peer; bỏ qua challenge; đổi D#/H#; tự chạy git commit/merge; tạo Peer trước khi spec và plan được duyệt |
| **Peer-impl** | Một task trong worktree riêng; phán đoán kỹ thuật trong scope (tên helper, vị trí file, call graph); TDD; tự chạy test trong sandbox | Đổi API chung, invariant, hành vi bên khác phụ thuộc → Lead | Ghi ngoài worktree; nhắn ai ngoài Lead; commit; push |
| **Peer-review** | Review theo contract; **chạy test** trên đúng commit; mỗi phát hiện dẫn `file:line` và lệnh chạy | Phát hiện, challenge → Lead | Sửa file tracked (plugin kiểm, §7) |

**Thứ tự thẩm quyền:** quyết định của anh > brief > spec > plan > ruling. Spec ràng buộc Lead; brief ràng buộc spec.

**Một owner mỗi scope:** scope (task) có đúng một owner tới khi bàn giao rõ (`slp_spawn` giao, `slp_accept`/`slp_release` trả). Reviewer review đúng commit hash, không review "branch hiện tại".

**Anh nói thẳng với Lead/Peer:**
- Hỏi / đọc: không ghi gì.
- Mọi prompt tới Lead/Peer không do plugin gửi được plugin ghi `human_message` vào state và báo Lead (§7). Lead quyết đó có phải đổi hướng không; nếu có, Lead ghi quyết định và chia lại scope. Peer nhận lệnh vượt scope thì `slp_ask` Lead, không tự làm.

**Gắn vai vào cơ chế:**
- Mỗi vai là một provider ID riêng trong `~/.paseo/config.json` (§8). Hook nhận vai qua field `provider` (payload hook không có label) — đã kiểm: provider tuỳ chỉnh `slp-probe` hiện đúng tên trong `before agent.create`, `session_open`, `agent.created`.
- Mặc định vendor: Supervisor = Claude, Lead = Claude, Peer-impl = Claude, Peer-review = Codex. Đổi được qua `extends`; ràng buộc duy nhất là reviewer khác vendor với implementer của task đó.
- Model, thinking, mode của từng vai đặt trong Paseo agent profile cùng tên vai; giá trị mặc định ở §8. Lead được ghi `model:` cho từng task trong plan, chỉ trong `models.allowed` (§8); plugin từ chối `slp_spawn` với model ngoài danh sách.

**Mọi vai SLP chạy trong sandbox.** Chỉ plugin chạy ngoài sandbox, và plugin không bao giờ chạy code của repo ngoài sandbox (§7, luật chung).

| Vai | Sandbox | Ghi được | Mạng |
|---|---|---|---|
| Supervisor, Lead (Claude) | Sandbox Claude Code (`providerOptions.sandbox`, `allowUnsandboxedCommands: false`, `denyRead: ~/.slp, ~/.paseo`; worktree của SLP nằm ở `~/.slp-worktrees`, ngoài cả hai) | Không gì (`denyWrite: cwd`); state chỉ qua tool `slp_*` | Chặn hết, kể cả localhost |
| Peer-impl (Claude) | Như trên | Chỉ worktree task, trừ file `<worktree>/.git` (`denyWrite`); `Write`/`Edit` ngoài worktree hoặc vào `.git` bị plugin từ chối theo `input.file_path` | Chỉ `claudeAllowedDomains` (đã kiểm S10a) |
| Peer-review (Codex) | Codex trong worktree dùng-một-lần. Rev 5.9: `config.toml` trong `CODEX_HOME` đặt `default_permissions` là profile kế thừa `:workspace` (ghi trong worktree, không mạng) và chặn đọc `~/.slp`, `~/.paseo` (`[permissions.<p>.filesystem] "<path>" = "deny"`). Agent không mang `modeId` hay `sandbox_mode`, vì Paseo 0.12 gửi sandbox kiểu cũ ở thread và ở mỗi turn khi có một trong hai, có thể đè profile | Worktree đó; plugin kiểm không đổi file tracked | T21 đo được localhost bị chặn (`000`; S3 trước đó thấy mở). Đọc `~/.slp`, `~/.paseo` được ở T21; cách chặn trên đã kiểm với `codex sandbox`, chưa kiểm qua app-server của Paseo (§13) |

Vai Claude chạy mode `default`. `autoAllowBashIfSandboxed` chỉ tự cho lệnh đơn giản: T21 thấy lệnh có `cd …`, `$(…)` hay `$?`, ghi bằng `>` hoặc heredoc vẫn thành permission request (giả thuyết rút từ 7 lần bị hỏi; chưa đọc source Claude Code). Rev 5.9: plugin **tự cho** mọi shell của vai Claude, sau khi đã từ chối lệnh dành riêng cho plugin và lệnh xin ra khỏi sandbox, vì sandbox là ranh giới thật. T21 thấy rõ: anh Accept curl localhost và `cat ~/.paseo/…`, sandbox vẫn chặn. Read/Grep/Glob trong repo và trong worktree SLP của project cũng tự cho. Còn lại (đọc ngoài các vùng đó, tool lạ) chờ anh (§7.1 Chặn quyền).

**Cô lập runtime** (rev 5.7, S11). Paseo nạp setting `user`, `project`, `local` cho mọi agent Claude, và Codex đọc `~/.codex` của anh. Mặc định agent SLP vì vậy nhận hook, MCP server, plugin và connector claude.ai của anh, cùng hook và `.mcp.json` trong checkout. Hook và MCP server chạy **ngoài** sandbox: một `.claude/settings.json` do Peer viết sẽ chạy với toàn quyền ở session sau trong checkout đó, kể cả session của anh sau khi merge. Vì vậy:
- Vai Claude: plugin thêm cờ CLI qua `providerOptions.extraArgs` (`--setting-sources=` rỗng, `--strict-mcp-config`, `--plugin-dir <Superpowers>`), `additionalDirectories: [cwd]` và env `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`. Kết quả: không hook, chỉ MCP `slp` (rev 5.9: `paseoTools.enabled: false` cho mọi vai), CLAUDE.md của repo và Superpowers vẫn có; CLAUDE.md toàn cục của anh thì không (T21 dòng 26 đạt).
- Vai Codex: env `CODEX_HOME=~/.slp/codex-home`. Plugin ghi lại `config.toml` trước mỗi lần tạo: không MCP, không project trusted, và rev 5.9 thêm permission profile chặn đọc ở trên. `auth.json` là symlink tới file của anh. Lúc chạy, Codex hoặc Paseo tự thêm `[projects."<repo>"] trust_level = "trusted"` (T21). Ghi lại file ở lần tạo sau là xoá dòng đó.
- `.claude/`, `.codex/`, `.mcp.json` là file được bảo vệ: `Write`/`Edit` bị từ chối và không bao giờ vào commit. Bash ghi vào `.claude/settings.json` và `.mcp.json` thì sandbox Claude đã tự chặn.
- Một chuỗi lệnh (rev 5.8): vai Claude bị bỏ tool `Agent`/`Task` (subagent có sẵn của Claude Code). Rev 5.10 (G1): bỏ thêm `AskUserQuestion`, vì Paseo biến nó thành một permission mà câu trả lời không phải tin nhắn, nên plugin không ghi được lời anh, và lời duyệt đi qua đó không qua được kiểm quote; vai hỏi anh bằng tin nhắn thường, có lựa chọn A/B/C ([smoke rev 5.10](../../research/smoke-2026-10-24-rev510.md)), và plugin từ chối tạo agent SLP có thinking `ultracode`. Mọi trợ giúp đi qua `slp_spawn`, nên trần writer, gói kiểm và quota vẫn đúng.

## 5. Shared state

```
~/.slp/
  config.json                    # §8
  <project>/
    project.jsonl                # sự kiện cấp project: contract_claim / contract_release, ngân sách, feature_record
    watch.json                   # trạng thái nhịp kiểm từng feature (§7.7)
    features/<slug>/
      events.jsonl               # log append-only — nguồn sự thật duy nhất của feature
      checkpoint-supervisor.md  checkpoint-lead.md   # checkpoint xoay vòng mới nhất của từng vai
      brief.v<N>.md  spec.v<N>.md  plan.v<N>.md   # mỗi version là file mới; event ghi sha256
      digest.md                  # plugin sinh lại sau mỗi event, ≤ ~30 dòng
      reports/<task>-<n>.md      # báo cáo đầy đủ của Peer — plugin ghi từ nội dung `slp_report` (digest chỉ trích tóm tắt)
```

### 5.1 Event

Mỗi dòng JSONL:

```json
{"seq": 42, "ts": "2026-10-21T10:00:00Z", "feature": "<slug>", "kind": "challenge",
 "id": "C3", "by_role": "peer-impl", "by_agent": "<paseo agent id>",
 "refs": ["T4", "D2"], "supersedes": null, "data": { } }
```

- `seq` tăng dần trong file; plugin cấp. Không sửa, không xoá dòng cũ.
- ID theo loại, đánh số tăng dần trong feature, không dùng lại: `D` decision, `H` hypothesis, `R` ruling, `C` challenge, `Q` câu hỏi `slp_ask`, `T` task (từ plan).
- Trạng thái **suy ra**, không lưu field status.

### 5.2 Loại event và ai được ghi

| `kind` | Ai ghi | Bắt buộc |
|---|---|---|
| `brief` (version + sha256) | Supervisor | Bản ghi brainstorm, không có cổng duyệt (rev 5.9): goal, success criteria kiểm được, hard constraints, D#/H#, các hướng đã cân nhắc kèm lý do chọn, phạm vi được chất vấn, ngân sách, non-goals. Brief v1 tạo feature (slug do Supervisor đặt, chưa tồn tại) và gắn Supervisor với nó; Supervisor đã có feature không tạo được feature thứ hai. Supervisor ghi brief v1 ngay khi đặt được slug, để gọi được Lead sớm |
| `premise` (D#/H# mới) | Supervisor (từ bản ghi brainstorm), Lead (từ spec) | H# phải có `verify_by` là phép đo có thể fail. Rev 5.9: `source` = `human` (anh chọn) / `supervisor` / `lead` (tự chọn), để lúc trình spec phần tự chọn hiện riêng. Mọi premise chỉ ràng buộc Peer sau khi anh duyệt spec. Rev 5.10: `slp_brief` nhận **toàn bộ** premise bản ghi còn giữ, mỗi cái kèm `id` đã có (lấy từ kết quả `slp_brief` trước). Plugin giữ premise cũ khi `id` trỏ tới premise còn sống (chưa bị gạch) cùng loại và cùng tiêu đề; nếu không, plugin giữ premise còn sống có cùng loại và tiêu đề (so tiêu đề không phân biệt hoa thường, gộp khoảng trắng), kể cả khi `id` thiếu hay trỏ sai (smoke lại: nhãn D# trong brief lệch id của plugin). Mọi premise khác, kể cả premise đổi tiêu đề, thành D#/H# mới; premise cũ đó bị gạch theo §5.3. Hai mục trùng nhau trong cùng một lần gọi chỉ thành một premise. Event `brief` ghi danh sách id của version đó. Kết quả tool liệt kê id và tiêu đề của từng premise, cùng các id bị bỏ |
| `human_decision` | Supervisor (hoặc Lead nếu anh nói thẳng với Lead; plugin báo Supervisor) | `quote`: nguyên văn lời anh; `decides`: approve spec/ship (kèm sha256 hoặc commit), supersede ID, keep ID, change goal (rev 5.9: bỏ approve brief). Plugin kiểm `quote` trong tin anh gửi (§7.6) |
| `supersede` D#/H# | Chỉ đi kèm `human_decision` | ID bị thay phải đang hiệu lực |
| `spec`, `plan` (version + sha256 + touch set) | Lead | plan: mỗi task có `Depends on`, task kiểm chứng có `Verifies` |
| `plan_approved` | Supervisor | sha256 của plan |
| `assign` / `release` | Lead (qua `slp_spawn` / `slp_accept`) | task, agent, worktree, BASE commit, model |
| `report` | Peer-impl | status (`done` / `done_with_concerns` / `blocked`), commit message đề xuất, nội dung báo cáo (mẫu ở §6.5). Plugin chuyển status và nội dung báo cáo cho Lead cùng thông báo commit; `blocked` mà không đổi file thì chỉ báo Lead, không trả lại Peer |
| `commit` | Plugin | hash, BASE, danh sách file, cờ: file ngoài touch set / file nhạy cảm bị loại |
| `merge` | Plugin (khi Lead `slp_accept`, hoặc Lead yêu cầu merge main) | nguồn, đích, hash kết quả, conflict? |
| `evidence` | Plugin | commit, lệnh (lấy từ plan hoặc config, không lấy từ Peer), chạy trong sandbox, exit code, thời gian |
| `review` | Peer-review | commit được review, phát hiện (`file:line`, lệnh, mức) |
| `challenge` C# | Peer-impl, Peer-review, Lead (lên Supervisor), Supervisor (lên anh) | target (T#/D#/H#/contract), claim, evidence (lệnh + output / test commit), impact, smallest_correction |
| `challenge_resolved` | Lead (mức plan) hoặc đi kèm `human_decision` (mức brief/spec) | accepted / rejected + lý do |
| `ask` Q# / `answer` | Peer → Lead; Lead → Supervisor | — |
| `ruling` R# | Lead | quyết định, lý do, `cost_if_wrong` |
| `confirms` H# | Lead | bắt buộc `evidence` |
| `human_message` | Plugin | agent nhận, trích nội dung |
| `ops` | Plugin | limit_hit, resumed, no_report_nudge, touch_set_violation, agent_closed, reconcile, log_truncated, watch_sent, watch_skipped, watch_unanswered |
| `watch_result` | Supervisor (trả lời gói kiểm, §7.7) | số thứ tự lần kiểm; mỗi agent: `ok` / `watch` / `intervene` + ghi chú |
| `contract_claim` / `contract_release` (trong `project.jsonl`) | Plugin (lúc `slp_approve_plan`; lúc `shipped` hoặc feature dừng) | tên contract, feature giữ |
| `ship_package` / `shipped` | Supervisor / plugin | commit hash, PR URL |
| `checkpoint` | Supervisor | path checkpoint |
| `feature_record` (trong `project.jsonl`) | Supervisor | số liệu §10 |

### 5.3 Trạng thái suy ra

- D#/H# **hiệu lực** khi chưa có `supersede` trỏ tới; H# **confirmed** khi có `confirms` kèm evidence; còn lại H# **open**.
- Rev 5.10: premise do một `brief` tạo, còn đang chờ duyệt, mà không có trong danh sách id của `brief` mới hơn → **bị gạch** (superseded bởi brief đó). Premise đã hiệu lực và premise Lead thêm qua `slp_spec` không bị brief gạch; đổi chúng vẫn đi qua `human_decision` supersede. Premise bị gạch không được `slp_spec` mang theo và không còn hiện là "chờ duyệt".
- Task: `pending` → `assigned` → `reported` → `accepted`; hoặc `parked` (tiền đề đang bị challenge mức spec), `stale` (đã accepted nhưng `Depends on` — trực tiếp hoặc qua T# — một ID đã bị supersede), `reopened`, `dropped`. `slp_accept` chỉ nhận task đang `reported`; task `parked` không accept được.
- Task chạm `contract:<tên>` chỉ spawn được khi feature của nó đang giữ contract đó (§6.4). `**Waits on:** <slug>` là chỗ plan khai feature đang giữ lúc duyệt.
- Task chỉ `accepted` khi có `commit` do plugin tạo từ `report` mới nhất, `evidence` exit code 0 trên đúng commit đó — lệnh là lệnh verify của task trong plan đã duyệt, chạy trong sandbox — và review trên đúng commit đó không còn phát hiện chặn.
- Feature chỉ nghiệm thu khi: không task `stale`/`parked`, không challenge mở, `evidence` xanh của lệnh `verify` của project (full suite) trên HEAD của `feat/<slug>`.

### 5.4 Digest

Plugin sinh lại `digest.md` sau mỗi event. Đây là thứ Supervisor đọc thường xuyên, cùng với gói kiểm (§7.7):

Rev 5.10: anh cũng đọc digest, vì gói kiểm hiện trong tab Supervisor (smoke lại: một dòng "Awaiting spec approval" dài hơn 30 premise). Luật trình bày:
- Dòng không có gì thì bỏ hẳn, không in "—".
- `Waiting on human` đứng ngay sau dòng phase.
- Premise chờ duyệt chỉ hiện ở phase `brainstorm` và `spec-review`, mỗi premise một dòng (`- D3 <tiêu đề> [human]`), tối đa 8 dòng rồi `- … +N more`. Sau khi spec được duyệt thì không in nữa.
- Giả thuyết open, challenge mở, task: mỗi mục một dòng.

```
# <slug> — phase: executing (plan v2, T5/9)
Waiting on human: permission Read for Peer T5 (6 min)
Owners: T5 → peer-impl agent_abc (worktree …, BASE 1a2b3c)
Open challenges: C3 (T4 memory cache vs retry contract) — Lead, 12 phút
Stale: T2 (depends D2, superseded by D4)
Open hypotheses: H1 (verify by T1) 
Contracts: giữ contract:session-store; T7 waits on login-v2 (contract:auth-api)
Ops: limit_hit codex 09:12 → resume 10:05 (2/6)
Watch: #14 10:15 — Lead ok; T5 watch (12 phút không đổi file)
Budget: 41% tokens, 0.6/2 ngày
```

## 6. Luồng làm việc

```
Anh mở Supervisor mới ─ý tưởng─► Supervisor brainstorm với anh (§6.1: mục đích trước, mỗi lần một câu,
      2–3 hướng có so sánh, quét ca biên) → brief.v1 = bản ghi brainstorm (tạo feature, không có cổng)
  → câu khó (nhiều hướng hậu quả khác nhau / phải đọc hay thử repo / khó đảo ngược):
      Supervisor đọc digest các feature đang chạy → slp_spawn Lead (worktree feat/<slug>, tham vấn)
      → Lead đọc repo, chạy thử trong sandbox, đề xuất / phản biện có bằng chứng
      → Supervisor (đại diện lời anh) và Lead (đại diện khả thi) tranh luận, tối đa 2 vòng
      → bảng so sánh các hướng cho anh chọn; anh tranh luận thẳng với Lead được
      → Supervisor cập nhật bản ghi (brief.vN), mỗi điểm ghi nguồn: anh chọn / tự chọn
  → câu dễ hay sở thích của anh: Supervisor tự hỏi anh, không gọi Lead
  → hết câu mở: Lead (gọi lúc này nếu chưa có) viết spec từ bản ghi (khoá contract)
  → Supervisor đối chiếu spec với bản ghi; quyết định Lead thêm mà bản ghi không có → hỏi anh ngay trong buổi
  → từ khi có Lead tới ship: mỗi 15 phút plugin gửi Supervisor gói kiểm (§7.7)
      ──[CỔNG 1: anh duyệt spec — điểm kết của brainstorm]
  → Lead viết plan → Supervisor duyệt (touch set, thứ tự verify-trước, ngân sách) → plugin ghi chủ contract
  → vòng task, tuần tự trong feature:
      Lead slp_spawn Peer-impl (worktree con từ feat/<slug>, model trong models.allowed) + task brief
      → TDD trong sandbox → slp_report (kết thúc turn)
      → plugin: commit thay Peer (hook tắt) → chạy lệnh verify + hook của repo trong sandbox → evidence
      → Lead slp_spawn Peer-review (vendor khác, worktree dùng-một-lần tại commit) → review
      → Lead slp_accept → plugin merge vào feat/<slug> (local, hook tắt) → task tiếp
  → Lead nghiệm thu (§5.3) → Supervisor đọc evidence trên HEAD → ship_package
      ──[CỔNG 2: anh duyệt ship, theo commit hash]
  → slp_ship: push + mở PR, nhả contract → plugin báo Lead và Supervisor của các feature khác
  → anh merge → các Lead khác merge main vào branch, chạy lại test
  → Supervisor ghi feature_record; nhịp kiểm dừng; anh archive tab Supervisor khi muốn
```

**Ngôn ngữ (rev 5.10, anh chốt).** Mọi vai viết cho anh bằng ngôn ngữ của tin mới nhất anh gửi: anh hỏi tiếng Việt thì trả lời tiếng Việt, anh hỏi tiếng Anh thì trả lời tiếng Anh. Brief, spec, plan, report, challenge và mọi tin giữa các vai viết bằng tiếng Anh. Câu chữ plugin tự sinh (gói kiểm, thông báo) giữ tiếng Anh.

### 6.1 Brainstorm và bản ghi brief (Supervisor dẫn, Lead tham vấn khi cần, không có cổng)

Rev 5.9. Brainstorm là bước kỹ nhất, làm cùng anh. Từ spec trở đi agent chỉ làm theo cái đã chốt, nên chỗ nào không hỏi ở đây là chỗ agent tự quyết thay anh.

**Supervisor dẫn**, theo tinh thần `superpowers:brainstorming`, dừng ở bước có spec. Supervisor không ghi file và không gọi `writing-plans`; spec và plan là việc của Lead.
1. Đọc repo trước khi hỏi (chỉ đọc), để câu hỏi đúng ngữ cảnh.
2. Mục đích trước: vì sao cần, cho ai, thế nào là xong. Mỗi lần một câu, có lựa chọn sẵn khi được. Không giới hạn số câu, không vội. Prompt vai cấm lối "chốt mặc định cho khỏi kéo dài phỏng vấn" (T21: Supervisor tự chọn D2/D3 sau 1 câu).
3. Với mỗi lựa chọn thiết kế thật (từ 2 hướng khả thi trở lên, hậu quả khác nhau): 2–3 hướng trong một bảng so sánh, cùng hàng cho mọi hướng (cách chạy, trong tình huống cụ thể, đánh đổi, hệ thống đổi gì, giới hạn, hợp khi), kèm đề xuất có điều kiện. Anh chọn.
4. Quét ca biên và chế độ lỗi cùng anh (input lạ, rỗng, quá dài, sai kiểu, lỗi giữa chừng). Ca biên không được để Lead tự quyết trong spec (T21: `" hello world"`, 6 → `"…"` lộ ra sau khi spec đã duyệt).
5. Viết lại hiểu biết cho anh sửa, tách "anh đã nói" khỏi "mình giả định".

**Gọi Lead vào tham vấn** khi gặp câu khó: nhiều hướng khả thi với hậu quả khác nhau; câu trả lời cần đọc hoặc chạy thử trong repo; quyết định khó đảo ngược (schema, API chung, migration). Câu dễ hay chỉ là sở thích của anh thì Supervisor tự hỏi.
- Supervisor `slp_spawn` Lead ngay khi có brief v1 (ghi brief v1 sớm, ngay khi đặt được slug), kèm câu hỏi cụ thể. Lead chưa tạo được Peer (§7.1 Spawn).
- Lead đọc repo, chạy thử trong sandbox, trả lời bằng `slp_send` tới Supervisor: các hướng, bằng chứng (file, lệnh và output, phản ví dụ), rủi ro.
- **Tranh luận:**
  - Supervisor đứng về phía ý anh, trích đúng lời anh. Lead đứng về phía khả thi, có bằng chứng.
  - Không nhượng bộ khi không có lý do. Không phản biện suông.
  - Tối đa 2 vòng cho mỗi câu. Chưa ngã ngũ thì gom thành **một** câu hỏi cho anh, kèm bảng so sánh.
  - Anh nhắn thẳng Lead được. Plugin ghi `human_message` và báo Supervisor.
- Lead đã có thì cũng là Lead viết spec và plan; không tạo Lead thứ hai.

**Bản ghi brief** (Supervisor ghi lại sau mỗi lần chốt bằng `slp_brief`, version mới mỗi lần; không có cổng duyệt). Rev 5.10: mỗi version gửi kèm mọi D#/H# bản ghi còn giữ, mỗi cái với `id` mà kết quả `slp_brief` trước đã trả, và trong markdown dùng đúng các id đó (§5.2). Bỏ một premise khỏi danh sách là gạch nó. Bản ghi gồm:
- Goal và vì sao.
- Success criteria kiểm được bằng máy hoặc bằng một quan sát cụ thể.
- Hard constraints **đã kiểm chứng** (mỗi cái ghi nguồn).
- Giả thuyết H#, mỗi cái có `verify-by`.
- Quyết định D#, mỗi cái ghi nguồn: anh chọn (kèm lời anh) hoặc **tự chọn** (anh đổi được).
- Các hướng đã cân nhắc và lý do chọn.
- Ca biên đã chốt.
- Lead được chất vấn những gì (mặc định: mọi thứ trừ goal; goal chỉ đổi qua anh).
- Ngân sách: thời gian thực, token / tiền.
- Non-goals.

Đây là handoff Supervisor → Lead của SLP: xây gì, vì sao, ràng buộc nào đã kiểm, giả định nào còn mở, quyết định nào đã chốt (và ai chốt), Lead còn được chất vấn gì.

### 6.2 Spec (Lead viết, Supervisor đối chiếu, anh duyệt: điểm kết của brainstorm)

- **Khoá contract:** API hứa gì, input hợp lệ, invariant/state phải giữ, nghĩa của "thành công", quyền sở hữu dữ liệu, cách biểu diễn lỗi, test chứng minh hành vi.
- **Không khoá:** tên helper, vị trí file, call graph.
- Mục `## Premises` liệt kê D#/H# spec dựa vào. ID đã bị supersede phải ghi chú `— superseded by <ID>`.
- Mọi câu đóng băng ("không đổi X", "frozen", "do not tune") phải trích ID nó bảo vệ, ví dụ `Không đổi model [D3]`. Nếu ID là H# đang open, viết rõ là đang đóng băng một giả thuyết.
- Supervisor đối chiếu trước khi trình anh: mọi H# trong brief vẫn là H# (không bị viết thành sự thật); không có ràng buộc mới thiếu nguồn; spec không vượt non-goals.
- Rev 5.9:
  - Spec có mục `## Decisions added by the Lead`, liệt kê mọi quyết định không có trong bản ghi brainstorm (ca biên, hành vi lỗi, giới hạn). Supervisor trình anh mục này trước cả spec.
  - Một quyết định trái với lời anh trong bản ghi thì không được vào spec: Lead phải challenge, Supervisor hỏi anh.
  - Duyệt spec là cổng đầu tiên và duy nhất trước khi code. Anh trả lời ngay trong buổi brainstorm.
- Rev 5.10 (F2: anh duyệt spec v1 rồi mới thấy "spec khó đọc"): spec viết tiếng Anh, nhưng trước khi xin duyệt, Supervisor trình nó bằng ngôn ngữ của anh, trong tab của mình, theo thứ tự: hàm hay tính năng làm gì (2–3 câu); bảng ví dụ input → kết quả, gồm ca thường, ca biên và ca lỗi; các quyết định Lead thêm; cuối cùng là đường dẫn tới file spec. Anh duyệt dựa trên bản trình đó; spec là bản ràng buộc.

### 6.3 Plan (Lead viết, Supervisor duyệt)

- Theo `superpowers:writing-plans` (đã kiểm S6: agent Claude trong Paseo nạp được Superpowers); nếu Lead đổi sang vendor không có skill, prompt vai Lead chứa format.
- Plan ghi quyết định, không ghi code (tinh thần 6.4.2): signature, assertion của test, giá trị lấy từ spec.
- Mỗi task: `**Outcome:**` anh hoặc task sau làm được gì khi task xong (rev 5.8; mô tả, không thuộc `taskDef`); `**Depends on:** D#, H#, T#`; task kiểm chứng: `**Verifies:** H#`; `**Touch set:**` file/module dự kiến sửa, contract chung ghi dạng `contract:<tên>`; tuỳ chọn `**Waits on:** <slug>` (chờ feature khác nhả contract); lệnh verify; tuỳ chọn `**Model:**` (chỉ trong `models.allowed`; bỏ trống = model của profile `slp-peer-impl`).
- Global Constraints: mỗi dòng kết bằng `[D#]`, `[H#]`, `[Goal]`, `[HC]`, hoặc `[Repo]`.
- Task `Depends on` một H# open phải đứng sau task `Verifies` H# đó.
- Supervisor từ chối plan khi: thiếu thứ tự verify-trước; task không nêu outcome hoặc lệnh verify không chạm tới outcome đó (test xanh không chứng minh UI dùng được hay save/reopen chạy); vượt ngân sách.
- Lead tách outcome bắt buộc khỏi cách làm đã chọn: một lựa chọn thiết kế hay yêu cầu của bản sau không tự thành điều kiện của task hiện tại. Chọn bước nhỏ nhất chạy được end-to-end; route nào thêm việc mà không đẩy outcome thì mở lại. Plugin từ chối `slp_approve_plan` khi plan chạm một `contract:` đang do feature khác giữ mà task chạm nó không có `Waits on` feature đó.

### 6.4 Song song giữa các feature

- Mỗi feature có Supervisor riêng; các Supervisor không nhắn nhau. Phần xuyên feature do plugin làm, theo luật cố định:
  - **Contract chung:** lúc `slp_approve_plan`, mỗi `contract:<tên>` trong plan được ghi `contract_claim` cho feature nếu chưa feature đang chạy nào giữ. Đang bị giữ → task chạm nó phải có `Waits on: <slug giữ>`, không thì plugin từ chối duyệt. Mỗi contract có một hàng chờ theo thứ tự duyệt plan; feature đầu hàng giữ contract. Feature giữ `shipped` hoặc dừng, hoặc plan mới của nó bỏ contract đó → `contract_release`; feature kế tiếp trong hàng giữ contract và Lead, Supervisor của nó được báo. v1 không chuyển chủ theo cách khác. Không xếp được → Supervisor hỏi anh thứ tự.
  - **Trùng file lặt vặt** (i18n, registry) → cho chạy, resolve lúc merge.
- Trước khi duyệt plan, Supervisor đọc digest của các feature đang chạy (chỉ đọc) để thấy chỗ chạm nhau mà luật trên không bắt (ví dụ cùng sửa một module nhưng không khai contract) và hỏi anh nếu cần.
- Trong lúc chạy: plugin canh touch set (§7).
- Sau khi một feature ship: plugin báo Lead và Supervisor của các feature còn lại; mỗi Lead yêu cầu plugin merge main vào branch (hook tắt). Conflict → Lead giao một task resolve cho Peer-impl như task thường; sau đó plugin chạy lại verify, ghi `evidence` mới.
- Trần writer: tối đa `maxWriters` Peer-impl đang chạy trên toàn project (mặc định 2); `slp_spawn` vượt trần thì xếp hàng.

### 6.5 Feedback ngược lên

**Challenge** — quyền, không phải nghĩa vụ; phải có bằng chứng.

1. Người phát hiện dừng tại chỗ phát hiện; không viết workaround để giữ tiền đề/plan.
2. Viết test tái hiện (nếu là code) trong worktree của mình.
3. Gọi `slp_challenge` (target, claim, evidence, impact, smallest_correction), kết thúc turn với `CHALLENGED`. Plugin commit trạng thái worktree (gồm test tái hiện) làm commit bằng chứng, chạy test đó trong sandbox, ghi `evidence`. Peer giữ scope và worktree trong lúc chờ.
4. Người nhận tái hiện bằng chứng (tự chạy, hoặc nhờ Peer-review chạy) trên đúng commit.
5. Phân loại:

| Target | Ai quyết | Xử lý |
|---|---|---|
| Chỉ plan (spec đúng) | Lead | Ruling R# + plan version mới; task accepted `Depends on` task bị đổi → `stale` → mở lại; follow-up cho chính Peer đó |
| Contract trong spec, D#/H# | Anh | Park task phụ thuộc; chạy tiếp task độc lập; Lead → Supervisor; Supervisor gom **một** câu hỏi: supersede (kèm đề xuất) / giữ (cần lý do) / đổi goal (dừng feature, brainstorm lại) |
| Bác | Lead (mức plan) | Ghi lý do; Peer làm tiếp task gốc; chỉ mở lại với bằng chứng mới |

6. Sau khi anh supersede: Lead sửa spec/plan thành version mới; task `stale` mở lại; bằng chứng làm mới trên trạng thái mới.

Lead tự đối chiếu với tiền đề (không chờ Peer) khi: eval/gate fail; một task tới fix round 3; một task `Verifies` xong (đạt → `confirms`; không đạt → challenge lên Supervisor). Cấm phản ứng kiểu Owner Assistant 09-25: gặp bằng chứng ngược mà thêm lớp bảo vệ, cắt prompt, thêm logging để giữ tiền đề.

Không phải challenge:
- Cách hay hơn mà plan vẫn đúng: nếu là chi tiết không bị khoá thì cứ làm; nếu chạm thứ đã khoá thì ghi `suggestion` trong báo cáo.
- Nghi ngờ không bằng chứng: hoàn thành task, báo `done_with_concerns`.

**Report của Peer và quyết định của Lead** (rev 5.8):
- Nội dung `slp_report`: đã làm gì; bốn danh sách ngắn: đã kiểm (lệnh và kết quả), chưa kiểm, fail, chưa biết; rủi ro còn lại. Bằng chứng phải khớp outcome của task.
- Peer có ba cách dừng có kiểu, mỗi cách kèm bằng chứng, hệ quả và quyết định hoặc dependency cần: tiền đề sai → `slp_challenge`; thiếu một tiền đề chưa ai sở hữu → `blocked` loại dependency; hết đường an toàn trong task → `blocked`.
- Lead đóng mỗi report bằng một quyết định: accept (`slp_accept`); yêu cầu sửa cụ thể (`slp_send` tới task, nêu thiếu gì); release kèm lý do (`slp_release`); hoặc hoãn, nêu ai giữ bước tiếp và lúc quay lại. Im lặng, "DONE" hay test xanh không phải quyết định. Gói kiểm (§7.7) liệt kê mọi report còn chờ Lead.

**`slp_ask` / `slp_answer`** — kênh hỏi không chặn:
- Peer → Lead, Lead → Supervisor. Plugin giao câu hỏi khi người nhận kết thúc turn (không ngắt giữa turn), giao câu trả lời ngược lại cho người hỏi.
- Q#/answer nằm trong state. Câu trả lời làm đổi hướng → Lead ghi thêm ruling hoặc challenge tương ứng.

### 6.6 Không ngồi chờ

Quyết định hay dependency vừa xong thì làm tiếp task sẵn sàng kế tiếp; xác nhận hay cập nhật tài liệu không phải điểm dừng. Không còn việc sẵn sàng thì Lead nêu đúng input hoặc quyền đang thiếu, ai giữ, và event nào cho đi tiếp. Không hỏi lại quyền đã cấp, không tự đặt thêm cổng duyệt (rev 5.8).

Ngoài brainstorm và 2 cổng, hệ thống không chờ anh. Khi đang chờ quyết định về một tiền đề, task độc lập vẫn chạy. Khi mọi task đều kẹt, Supervisor gửi câu hỏi gom.

Rev 5.9: vai SLP không còn Paseo tools, nên không tạo được heartbeat. Thay vào đó plugin nhắc: gói kiểm (§7.7) có dòng "Waiting on human" kèm số phút; quá `limits.humanReminderMinutes` (mặc định 30) thì Supervisor nhắc anh một dòng trong tab của mình. Paseo đánh dấu tab có tin mới.

Agent chờ permission của anh cũng hiện trong gói kiểm, và Supervisor báo anh. T21 có một Lead treo 75 phút ở một popup mà không ai được báo, vì timer đã dừng (§7.7). Supervisor không bao giờ tự trả lời thay anh ở cổng.

### 6.7 Ship

- Gói ship: diff tóm tắt (file, dòng), success criteria từng cái → bằng chứng, `evidence` của plugin trên commit ship, danh sách rulings kèm `cost_if_wrong`, giả thuyết còn open, những gì khác với brief.
- Anh duyệt bằng một câu trả lời rõ (ví dụ "ship"); không cần gõ hash. Supervisor ghi `human_decision` kèm quote và commit hash của `ship_package` vừa trình; plugin kiểm (§7.6).
- `slp_ship` push `feat/<slug>` và mở PR (gh). Merge luôn do anh.
- Rev 5.10 (F7): `ship.openPr: false` thì `slp_ship` chỉ push. Gói ship và câu xin duyệt nói đúng điều sẽ xảy ra ("push `feat/<slug>` lên `<remote>`"), không hứa mở PR.

## 7. Plugin `slp`

Phần server (`index.server.ts`) chạy trên daemon kể cả khi app đóng, và giữ mọi luật, state và thao tác git. Rev 5.9: phần client chỉ gọi RPC "wake" khi app mở, để timer chạy được sau khi reload plugin mà chưa có hook nào (§7.1 Nhịp kiểm); nó không quyết gì. View trace có spec riêng (§3).

**Luật chung:**
- Agent SLP không có tool Paseo nào (`paseoTools.enabled: false` cho cả 4 provider ID; rev 5.9). Mọi tạo agent, nhắn tin, báo cáo đi qua MCP server `slp` do plugin inject.
  - Lý do (T21, B-3): Paseo tự cho tool `paseo` mà không gửi permission request. Supervisor gọi được `list_terminals` mà không có popup, nên `create_terminal`/`send_terminal_keys` (shell do daemon chạy, ngoài sandbox), `*_schedule`/heartbeat (tạo agent ngoài SLP), `set_agent_mode` (chuyển sang `bypassPermissions` là tắt permission policy của plugin) đều là đường thoát.
  - Bản 5.8 chỉ tắt `create_agent`, `send_agent_prompt`, `kill_agent`, và như vậy không đủ.
  - Provider config chỉ có hiệu lực khi tiến trình agent khởi động.
  - Plugin từ chối tạo agent SLP nếu provider `slp-*` nào còn bật Paseo tools, và `permissions.ts` từ chối `mcp__paseo__*` như lớp thứ hai.
- **Plugin là actor duy nhất chạy ngoài sandbox, và không bao giờ chạy code của repo ngoài sandbox.** Lý do: hook (husky…), test và cả file `<worktree>/.git` nằm trong worktree, Peer sửa được. Cụ thể:
  - Mọi lệnh git của plugin chạy với `-c core.hooksPath=/dev/null -c core.fsmonitor=false`, commit/merge thêm `--no-verify`.
  - `--git-dir` lấy từ common dir của repo trong `~/.slp/config.json`; file `<worktree>/.git` không được tin.
  - Mọi lệnh verify và hook của repo chạy qua `codex sandbox -P slp-verify -C <worktree> -- <cmd>` (S10b với `:workspace`: chặn ghi `$HOME`, chặn localhost, exit code giữ nguyên; rev 5.9: `slp-verify` kế thừa `:workspace` và chặn thêm đọc `sandbox.denyRead`, `CODEX_HOME` riêng của runner).
- **Paseo cũng chạy code của repo ngoài sandbox khi tạo worktree**: hook `post-checkout` và `worktree.setup` trong `paseo.json` của branch gốc. Vì vậy plugin không bao giờ đưa thay đổi ở thư mục hook hay `paseo.json` vào commit (loại như file nhạy cảm, báo Lead). Chừng đó chưa đủ: lệnh setup gọi file khác của repo (`npm ci` chạy `postinstall`), hook có thể nằm sau symlink, và `teardown` được đọc từ chính worktree lúc archive. Ba vòng review cho thấy chặn theo đường dẫn không kín, nên rev 5.2 bỏ hẳn vòng đời worktree của Paseo cho agent SLP: **plugin tự tạo worktree** với hook tắt và gắn agent vào workspace `directory`; Paseo không chạy setup cho loại này và không chạy teardown cho thư mục ngoài `~/.paseo/worktrees`. Cài dependency do Peer làm trong sandbox hoặc nằm trong lệnh verify. Rev 5.3: hook tắt không tắt git filter; repo có filter, merge driver hay `textconv` chạy lệnh (trừ `git-lfs`) thì SLP từ chối project (fail closed), vì `.gitattributes` trong cây chọn chúng và lệnh có thể là script Peer sửa được. Cái giá: filter vô hại như `nbstripout` cũng bị chặn; anh gỡ khỏi config của repo nếu muốn dùng SLP ở đó.

### 7.1 Thành phần

| Thành phần | Làm gì | Cơ chế | Chặn lỗi nào |
|---|---|---|---|
| Gắn vai | Theo provider ID: system prompt vai; MCP `slp` (http, `headers.Authorization` = token riêng của agent); mode `default` cho vai Claude; sandbox theo §4 (Claude: `providerOptions.sandbox`; Codex reviewer: profile `default_permissions` trong `CODEX_HOME`, không `modeId`, không `sandbox_mode`); cô lập runtime theo §4 (Claude: `extraArgs`, `additionalDirectories`, env; Codex: `CODEX_HOME`); ghi worktree + branch thật vào identity; từ chối Lead/Peer chạy trong checkout chính, reviewer không ở đúng commit. Rev 5.9: provider và agent profile được đọc lại từ `paseo.config.get()` mỗi lần tạo agent SLP, không chụp một lần lúc hook đầu tiên (B-1: profile tạo sau lúc plugin khởi động làm `slp_spawn` lỗi `Expected config.provider in "provider/model" format`); vai không có profile và cũng không có model thì báo lỗi rõ ("chưa có agent profile cho `slp-lead`"). Rev 5.10 (F6): Paseo lưu agent config nhưng không lưu env override, và mở lại phiên (`session_open` với `reason` create / resume / refresh / import) mà không có env đó. Vì vậy env của vai (Codex: `CODEX_HOME` của SLP, viết lại `config.toml` trước; Claude: `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`) được tính lại từ `provider` ở mọi lần mở phiên, cùng một hàm với lúc tạo. Smoke lại: reload reviewer Codex mở lại thread ở `~/.codex` → "no rollout found" → agent đóng | `before agent.create` (chạy sau khi Paseo tạo worktree) + `before agent.session_open` (env) | Vai trôi; Peer sửa state; agent chạy sai chỗ; lỗi khó hiểu khi thiếu profile |
| Định danh agent | Token ngẫu nhiên cho từng agent, đặt vào header MCP và `env.SLP_TOKEN`; plugin chỉ lưu `sha256(token)`; `before agent.session_open` (có `agentId`) gắn token → agent + vai. Không dùng token chung kiểu Paseo (giả mạo được) | `before agent.create` + `session_open` (S1 đã kiểm) | Agent mạo danh vai khác |
| Duyệt sẵn tool của mình | `toolPolicy.preapproved` = các tool `slp_*` của vai (Claude: `allowedTools`; Codex: `approval_mode: "approve"`); chính tool tự kiểm quyền | `before agent.create` | Permission prompt dội về anh |
| Router | Chỉ cho các cạnh ở §7.3. Paseo không có hàng đợi và mặc định **ngắt** turn đang chạy, nên plugin tự xếp hàng và chỉ giao khi người nhận `idle` (kiểm `status`/`activeTurn`); tin plugin gửi mang `messageId` dạng `slp-<uuid>`. Ngoại lệ duy nhất: `slp_send(mode: "steer" \| "interrupt")` từ Supervisor tới Lead của feature mình, và từ Lead tới Peer của mình — chen vào (steer) hoặc huỷ (interrupt) turn đang chạy; người nhận đang rảnh thì giao như thường | MCP + SDK `agent.send({messageId})` | Supervisor lách Lead; ngắt giữa turn; agent quay vòng không bao giờ rảnh để nhận tin |
| Spawn | `slp_spawn`: Supervisor chỉ tạo Lead cho feature của mình, tối đa một Lead sống mỗi feature (Lead chết thì tạo lại được); rev 5.9: Supervisor tạo được Lead ngay khi feature có brief v1, không cần duyệt gì (tham vấn trong brainstorm), còn Peer chỉ tạo được khi spec đã được anh duyệt và plan đã được Supervisor duyệt (smoke: cổng plan đã chặn đúng một lần Lead tạo Peer sớm); `slp_spawn` vai Lead từ chối tham số `model` (B-2: trước đây nhận rồi bỏ qua; model của Lead lấy từ profile); Lead chỉ tạo Peer của feature mình; task có `Waits on` chưa nhả → từ chối. Workspace của mọi agent SLP tạo với `projectId` = project của repo (tra `projects.list()` theo `rootPath` = realpath của repo; chưa có thì tạo bằng `workspaces.open(repo)`); workspace Peer-impl và reviewer thêm `background: true` (B-9, đã thử bằng CLI: nằm dưới project / không hiện trong sidebar, không sinh project mới). Plugin tạo worktree (hook tắt): Lead `feat/<slug>` từ base; Peer-impl `slp/<slug>/<task>-<n>` từ `feat/<slug>`; reviewer một branch riêng từ đúng commit đã verify. Ghi `assign` (task, worktree, branch, BASE, model); áp trần writer; model phải trong `models.allowed`; tạo với `parent` = agent gọi (S8). `merge_base: true` tạo Peer-impl cho task resolve: plugin chạy `git merge --no-commit <base>` trong worktree (hook tắt) rồi mới gửi brief | MCP + SDK `agents.create({ parent, worktree })` | Vai tạo sai vai; lẫn worktree; model ngoài ý anh |
| State + digest | Kiểm quyền theo §5.2 rồi append; sinh lại digest; ghi `reports/` từ nội dung tool | MCP | Ghi vượt quyền; Supervisor tràn context |
| Ghi tin của anh | `user_message` không mang `messageId` tiền tố `slp-` và không nằm trong vỏ `<paseo-system>` → `human_message` (S4 đã kiểm). Tin agent gửi agent qua CLI/MCP hiện là `agent_message` có `sender` (0.12). Ghi ở `turn_started`, `turn_ended`, và ở đầu mọi tool tạo thứ cần duyệt hoặc kiểm câu duyệt. Tới Lead/Peer: báo thêm Lead của feature. Tới Supervisor: chỉ ghi. Rev 5.9: tin tới Lead: báo Supervisor (§6.1; Supervisor giữ bản ghi brainstorm); Lead ghi một quyết định của anh bằng `slp_human_decision` thì Supervisor cũng được báo (smoke: anh duyệt spec ở tab Lead, Supervisor không biết, giữ plan lại); nhãn đúng vai (B-6: tin tới reviewer bị báo là "Peer T1"). B-4: `paseo agent reload` phát lại timeline thành `user_message` mới với `messageId` mới (T21: chữ "duyệt" cũ được ghi lại lần hai, kèm cả tin `[SLP from …]`), nên plugin chỉ ghi item timeline mới hơn mốc đã ghi của agent đó (dấu thời gian item và epoch timeline; Paseo tạo epoch mới mỗi lần nạp lại lịch sử), không bao giờ ghi item có vỏ `[SLP …]` do router gửi, và khi epoch đổi, hoặc agent chưa có mốc mà đã có tin của anh, thì không ghi lại item trùng nội dung một tin đã ghi (lọc thừa thì anh gõ lại; lọc thiếu thì giả được lời duyệt) | `turn_started`/`turn_ended` + `timeline.refetch` | Anh đổi hướng ở Peer, Lead không biết; anh phải gõ "duyệt" hai lần; reload agent giả lời duyệt |
| Watchdog limit | Nhận diện limit từ text cuối turn / thông báo turn fail (Paseo không tự nhận diện, S2); giờ reset lấy từ `providers.listUsage()` (`providers[].windows[].resetsAt`); hẹn `agent.send` "tiếp tục" lúc reset, tin resume giãn 15 s; số lần resume lưu theo agent tới khi một turn kết thúc không dính limit; trần `resumeMaxAttempts`; hết lượt mới báo Supervisor. Đơn giản hoá v1: không tạm dừng cả vendor, mỗi agent tự dính rồi tự hẹn. Bộ nhận diện không được khớp lỗi đĩa (`disk quota exceeded`, `EDQUOT`, `ENOSPC`). Lần dính limit thật đầu tiên phải được ghi nguyên văn để chỉnh bộ nhận diện | `agent.turn_ended` + timer + usage API | 33 lần dừng limit, 16 "Try again" |
| Không báo cáo | Peer kết turn mà không `slp_report`/`slp_challenge`/`slp_ask`/`slp_review` → nhắc `noReportNudges` lần, rồi báo Lead. Tool khác (`slp_state`…) không tính là báo cáo. Turn bị anh ngắt tay (`canceled`) không bị nhắc. Rev 5.9 (B-7): sau khi report đã được báo Lead, turn không đổi file nào không bị nhắc (anh hay Lead hỏi, Peer trả lời bằng chữ); turn có đổi file mà không `slp_report` thì vẫn bị nhắc. Reviewer đã có review được tính thì không bị nhắc. Prompt của Peer và reviewer nói rõ điều này (T21: tin thử của anh ép reviewer và Peer mở thêm Q2/Q3 chỉ để đóng turn). Rev 5.10 (F4): câu nhắc nêu đúng tool của vai: Peer-impl `slp_report`, reviewer `slp_review`, cùng `slp_challenge`, `slp_ask` | `agent.turn_ended` | Dừng im lặng |
| Commit thay Peer | Sau `slp_report` (chờ turn của Peer kết thúc hẳn; xử lý turn_ended tuần tự theo agent): `git status`; từ chối nếu không có thay đổi; loại file nhạy cảm (`.env*`, khoá) và file được bảo vệ (hook, `paseo.json`, `.claude/`, `.codex/`, `.mcp.json`) và báo; file ngoài touch set → vẫn commit, cờ cho Lead; `git add` + commit hook tắt, message = `T#: <message của Peer>` + trailer `SLP-Task`, `SLP-Agent` → `commit`. Báo đúng một lần cho mỗi cặp (report, kết quả xử lý: commit + kết quả kiểm, `blocked`, bị từ chối): plugin ghi `ops report_notified {reportSeq, result}` sau khi xếp tin, chỉ khi hàng đợi router đã nằm trên đĩa; report cũ gặp lại không báo lại, report mới trên commit cũ vẫn báo (nó mang câu trả lời của Peer), runner hỏng chỉ báo một lần cho tới khi kết quả đổi (B-5: T21 một report được báo 2 lần, thêm 3 bản trong hàng đợi). Worktree sạch mà HEAD là commit của plugin chưa có event (crash giữa commit và ghi) → ghi `commit` cho HEAD rồi verify tiếp | MCP + git (hook tắt, git dir tin cậy) | Peer khai sai commit; hook chạy ngoài sandbox; task kẹt sau crash |
| Kiểm bằng chứng | Trên commit vừa tạo: chạy lệnh verify của task (từ plan đã duyệt) và hook pre-commit của repo nếu có, **trong sandbox**, có timeout → `evidence`. Trước mỗi lần verify, thử runner bằng `true`; runner hỏng → `ops runner_failed`, báo Supervisor, không nhắn Peer, không có `evidence` (fail closed); lần sau verify lại trên đúng commit. Khi nghiệm thu feature và trước ship: `verify` của project (full suite) trên HEAD, trong sandbox. Lệnh do Peer khai chỉ có `repro_command` của challenge, và chỉ chạy trong sandbox. Rev 5.9: runner dùng permission profile riêng (`-P slp-verify`, kế thừa `:workspace`, chặn đọc `~/.slp`, `~/.paseo`), vì test do Peer viết chạy trong runner và in được bí mật vào `stdoutTail` của evidence | `codex sandbox -P slp-verify` | ~25 claim "xong" sai; Peer đốt fix round vào lỗi hạ tầng |
| Merge | `slp_accept` → plugin merge branch task vào `feat/<slug>` (hook tắt); Lead yêu cầu → plugin merge main vào `feat/<slug>`; conflict → báo Lead, không tự resolve; Lead giao task resolve bằng `slp_spawn … merge_base: true` | git (hook tắt) | Hook chạy với quyền của Lead |
| Reviewer không sửa | Sau turn của Peer-review: `git status --porcelain` trên file tracked phải rỗng; nếu không → review vô hiệu, dừng reviewer, archive workspace, xoá branch review, báo Lead spawn reviewer mới | `agent.turn_ended` | Reviewer sửa code |
| Chặn quyền | Từ chối: shell gọi `paseo`, `git push`, `git commit`/`merge` từ agent, lệnh xin ra khỏi sandbox; `Write`/`Edit` có `input.file_path` ngoài worktree của agent hoặc vào `<worktree>/.git` (S10a đã kiểm); mọi tool có đường dẫn trong `~/.slp` hay `~/.paseo`; `WebFetch` tới localhost; rev 5.9: mọi `mcp__paseo__*`, và mọi yêu cầu duyệt shell của vai Codex (với Codex, xin duyệt nghĩa là xin chạy ngoài sandbox). Rev 5.9 (B-8) tự cho: shell của vai Claude còn lại sau các luật từ chối (sandbox `allowUnsandboxedCommands: false` + `failIfUnavailable` là ranh giới); `Read`/`Grep`/`Glob` có đường dẫn trong repo của project hoặc trong `~/.slp-worktrees/<project>/`. Còn lại (đọc ngoài các vùng đó, vì tool `Read` không chạy trong sandbox; tool lạ): request chờ anh trong app. T21: 7 popup shell/Read cho một feature 1 task, mục tiêu là 0 | `agent.permission_requested` (S5 đã kiểm) | Lách router; ghi ngoài scope; đọc token của agent khác |
| Canh touch set | Sau mỗi commit: file ngoài touch set task → báo Lead; file trong touch set của feature khác đang chạy → báo Supervisor của feature đó | `commit` | Lấn scope; feature chạm nhau |
| Giữ contract | Lúc `slp_approve_plan`: ghi `contract_claim` cho các `contract:` chưa ai giữ; từ chối duyệt nếu chạm contract đang bị feature khác giữ mà task không `Waits on` feature đó; lúc `shipped` / feature dừng / plan mới bỏ contract: `contract_release`, báo Lead và Supervisor của feature giữ kế tiếp (§6.4); `slp_spawn` từ chối task chạm contract mà feature chưa giữ | MCP + `project.jsonl` | Hai feature cùng sửa một contract; feature chờ mãi không biết |
| Nhịp kiểm | Mỗi `watch.intervalMinutes` dựng gói kiểm cho từng feature và gửi Supervisor của feature đó (§7.7). Rev 5.9: timer không được phụ thuộc hook đầu tiên sau reload (T21 dòng 24: sau `plugin reload` lúc 04:40 không có lần kiểm nào nữa, Lead treo 75 phút ở một popup). API plugin 0.12 chỉ đưa client Paseo trong hook và handler RPC, nên client plugin gọi RPC "wake" khi app mở và mỗi phút; wake chỉ đưa client cho plugin, không tự chạy tick. Tick 30 s kế tiếp chạy bù (gói kiểm so `lastAt` với `watch.intervalMinutes`), và khoảng giãn giữa các tin resume vẫn chỉ do timer quyết, dù có bao nhiêu client. Reconcile lúc có client dựng lại các permission đang chờ từ snapshot agent | timer + SDK `refresh()` + `timeline.refetch` + git (hook tắt) | Agent quay vòng / overthink / sai hướng / treo ở permission mà không ai thấy |
| Cổng ship | `slp_ship` chỉ Supervisor; chỉ khi có `human_decision` duyệt ship đúng commit hash đã qua kiểm quote | MCP | Push trước khi anh duyệt |
| Đối soát | Khi plugin khởi động: đọc state, liệt kê agent qua SDK, so khớp; agent không còn (SDK trả null hoặc `closed`) → retire định danh, nhả slot writer; giao lại hàng đợi đã lưu; nhắc agent rảnh chưa báo cáo; ghi `ops: reconcile`. Dòng cuối của một file JSONL bị cắt dở (crash giữa lúc ghi) → bỏ đúng dòng đó, ghi `ops: log_truncated`; dòng hỏng ở giữa file → fail closed | khởi động plugin | Sự kiện Paseo không replay; Peer chết vẫn chiếm trần writer; plugin không khởi động được sau crash |

### 7.2 Tool MCP theo vai

Mọi vai: `slp_state(scope?)` — đọc digest / event của feature mình. Supervisor đọc thêm được digest của mọi feature trong project (chỉ đọc).

| Vai | Tool |
|---|---|
| Supervisor | `slp_brief` (ghi version; v1 tạo feature), `slp_human_decision`, `slp_approve_plan`, `slp_spawn` (Lead), `slp_send` (→ Lead của mình; `mode`: `queue` mặc định / `steer` / `interrupt`), `slp_answer` (cho Lead), `slp_challenge` (→ anh, dạng câu hỏi gom), `slp_watch_result`, `slp_activity` (Lead, Peer của feature mình), `slp_ship_package`, `slp_ship`, `slp_checkpoint` |
| Lead | `slp_spec`, `slp_plan`, `slp_spawn` (Peer; `merge_base` cho task resolve), `slp_send` (→ Peer của mình, có `mode`; → Supervisor, chỉ `queue`), `slp_activity` (Peer của mình), `slp_accept`, `slp_release`, `slp_merge_main`, `slp_rule`, `slp_resolve`, `slp_confirm`, `slp_answer`, `slp_ask` (→ Supervisor), `slp_challenge` (→ Supervisor), `slp_human_decision` (khi anh nói thẳng với Lead), `slp_checkpoint` |
| Peer-impl | `slp_report`, `slp_challenge`, `slp_ask` |
| Peer-review | `slp_review`, `slp_challenge`, `slp_ask` |

Tên tool là chỉ dẫn; plan có thể đổi tên nhưng không đổi quyền.

### 7.3 Cạnh router

```
Supervisor ⇄ Lead của feature mình      (Supervisor → Lead: queue / steer / interrupt)
Lead ⇄ Peer do chính Lead đó spawn       (Lead → Peer: queue / steer / interrupt)
Plugin → bất kỳ (nhắc, resume, gói kiểm, báo xuyên feature, giao hàng đợi)
Không có: Supervisor → Peer, Supervisor ⇄ Supervisor, Supervisor A → Lead B,
          Peer → Peer, Peer → Supervisor, Lead A → Peer của Lead B
Mọi cạnh khác chiều (Lead → Supervisor, Peer → Lead): chỉ queue
```

### 7.4 Vòng đời agent

- Supervisor: mỗi ý tưởng anh tạo một agent Paseo bằng profile `slp-supervisor` trong workspace thư mục gốc của project (không phải workspace worktree). Nó gắn với feature ở `slp_brief` v1; trước đó chưa có state nào và `slp_checkpoint` bị từ chối. Không tự tạo heartbeat định kỳ: nhịp kiểm do plugin gửi (§7.7).
- Supervisor nhận sự kiện qua router (plugin `agent.send`), không qua thông báo cha-con.
- Feature `shipped` hoặc dừng: Supervisor ghi `feature_record`; plugin dừng nhịp kiểm và nhả contract; tab Supervisor để anh archive.
- Lead/Peer do `slp_spawn` tạo với `parent`, nên hiện trong Subagents track của agent cha; tên dạng `[Lead] <slug>`, `[Peer T4] <slug>`.
- Rev 5.9: trên sidebar, feature hiện một dòng `[Lead] <slug>` dưới project của repo. Peer và reviewer chạy nền.
  - Chưa kiểm: chip "subagents" của Lead có còn mở được Peer chạy nền không. Kiểm ở lượt smoke lại.
  - Nếu không mở được, đường mở Peer là view trace (§3, spec riêng) hoặc `paseo agent open <id>`.
- Mỗi worktree một workspace. T21 thấy 3 workspace `[Lead] slugify` trùng một worktree, có lẽ do `agent reload` (chưa kiểm). Plugin dùng lại workspace đã ghi trong identity, không tạo thêm.

### 7.5 Xoay vòng

- Ngưỡng: `lastUsage.contextWindowUsedTokens / contextWindowMaxTokens` ≥ `rotation.contextRatio` (đọc qua SDK `refresh()` sau mỗi turn; S7 đã kiểm). Provider nào không báo thì dùng `rotation.maxTurns`.
- Khi tới ngưỡng: agent gọi `slp_checkpoint` (việc đang dở, câu hỏi chờ anh, cam kết đã hứa với anh, feature đang theo) → plugin tạo agent mới cùng vai **trong workspace cũ** (Lead dùng lại đúng worktree; Supervisor ở thư mục project), prompt đầu là checkpoint + digest → archive agent cũ (không archive workspace). Router chuyển địa chỉ vai sang agent mới; hàng đợi và nhịp kiểm giữ nguyên. Lời nhắc anh (§6.6) do plugin giữ theo feature nên không mất khi xoay vòng (rev 5.9).
- Luật vai không phụ thuộc compaction: plugin gắn lúc tạo; quyết định nằm trong state; mỗi lần thức dậy agent đọc lại digest.

### 7.6 Kiểm quyết định của anh

`human_decision` chỉ được ghi khi `quote` nằm trọn từ trong `human_message` **mới nhất** của anh gửi agent đang ghi, sau event cần duyệt. Tin sau ("khoan, chưa duyệt", "wait, stop") luôn đè tin trước. Mệnh đề chứa quote không có từ phủ định (không, ko, chưa, đừng, no, not…) và không phải câu hỏi. Ở cổng duyệt (spec, ship; rev 5.9 bỏ brief), **mọi** mệnh đề của tin phải là câu "đồng ý" thuần: có từ duyệt (`duyệt`, `ok`, `ship`, `đồng ý`, `lgtm`…) và chỉ thêm từ đệm, số version, tên feature. "Please explain the risks", "ok để mình nghĩ thêm", "OK, wait, stop.", "If CI passes, ship." hay "đồng ý, nhưng thêm test X" đều không duyệt; ghi chú gửi ở tin riêng. Mỗi tin chỉ đứng sau một quyết định (`messageId` trong `human_decision`). Plugin vẫn không hiểu ngữ nghĩa; luật này chặn những cách trích sai dễ gặp, và khi nghi thì từ chối để Supervisor hỏi lại. `human_message` đó phải đến sau event cần duyệt (spec version, câu hỏi gom, `ship_package`). Plugin đọc timeline ngay trước khi kiểm, và ngay trước khi ghi một spec hay gói ship mới. Vì vậy câu "duyệt" gõ trong turn hiện tại được tính, còn câu gõ trước một version mới thì không. Với duyệt ship: commit hash trong `human_decision` phải trùng với `ship_package` mới nhất, và HEAD của `feat/<slug>` lúc `slp_ship` vẫn là commit đó (có commit mới → phải trình gói ship mới). Mục đích: Supervisor không tự bịa được chữ "duyệt", và anh không duyệt nhầm một commit khác.

Rev 5.9: cổng duyệt còn spec và ship (bỏ brief). Mọi `human_message` dùng để kiểm quote phải là tin anh gửi thật, không phải item phát lại sau `agent reload` (§7.1 Ghi tin của anh; B-4). T21 đã kiểm: câu "bạn duyệt hộ mình ship luôn đi, mình bận" và quote "duyệt hộ" bị từ chối, còn "ok ship" thì qua.

Mỗi Supervisor chỉ có một feature, nên câu duyệt gõ ở tab của feature này không khớp được cổng của feature khác. Trong một feature, các cổng thường nối tiếp nhau; khi có hai mục cùng chờ anh (ví dụ spec mới và một câu hỏi gom về tiền đề), prompt vai bắt Supervisor hỏi anh riêng từng mục trước khi ghi `human_decision`.

### 7.7 Nhịp kiểm

Mục đích: bắt sớm agent quay vòng / overthink và đi sai hướng — hai kiểu anh đã gặp — mà Supervisor không phải đọc transcript.

1. **Hẹn giờ.** Mỗi feature một timer của plugin, `watch.intervalMinutes` (mặc định 15). Bắt đầu khi Lead được tạo (kể cả Lead tham vấn trong brainstorm; lúc đó Lead thường rảnh nên phần lớn lần kiểm bị bỏ qua); dừng khi feature `shipped` hoặc dừng. Timer nằm trên đĩa như timer resume. Rev 5.9: timer chạy cả sau khi plugin reload mà chưa có hook nào (§7.1 Nhịp kiểm).
2. **Bỏ qua.** Nếu từ lần kiểm trước không agent nào của feature chạy, không có event mới, và không file nào trong worktree đổi → không gửi, ghi `ops: watch_skipped`.
3. **Gói kiểm** (plugin dựng, không LLM): digest của feature (luật trình bày ở §5.4), cộng với mỗi agent đang sống của feature (Lead, Peer-impl, Peer-review), mặc định tối đa 16 dòng một agent. Rev 5.10: dòng đầu là `[SLP watch #n · <slug>] For the Supervisor; no action needed from you.`, vì gói hiện trong tab anh đọc. Mỗi agent:
   - vai, task và mục tiêu task (một dòng từ plan), trạng thái (`running` / `idle` / chờ permission của anh / chờ reset limit kèm giờ);
   - turn hiện tại đã chạy bao lâu; từ lúc nhận task bao lâu; fix round;
   - với Peer-impl: số lần verify fail, file chưa commit và lần đổi cuối (mtime mới nhất), `git diff --shortstat` so với BASE;
   - `watch.packToolCalls` (mặc định 10) tool call gần nhất: tên, tham số rút gọn ≤ 80 ký tự, exit code hoặc lỗi;
   - lặp lại trong 60 item timeline gần nhất: lệnh giống nhau chạy ≥ 3 lần, file bị đọc ≥ 4 lần.
   - dòng tool call ghi "N of M", để Supervisor biết gói đã cắt (rev 5.8);
   - cuối gói: "Waiting for the Lead's decision" (task `reported` mà Lead chưa accept/release, kèm số phút) và "Your open items" (verdict `watch`/`intervene` mới nhất của mỗi agent chưa được đóng) (rev 5.8).
4. **Giao.** Qua router như tin plugin (`slp-` messageId): chỉ khi Supervisor `idle`, nên không ngắt lúc anh đang chat. Gói chưa giao bị gói mới thay, không chồng lên. Ghi `ops: watch_sent`. Lúc gửi gói mới mà gói trước đã giao nhưng chưa có `slp_watch_result` → `ops: watch_unanswered`.
5. **Phán.** Supervisor đánh giá từng agent: `ok`, `watch` (để ý lần sau), `intervene`; ghi bằng `slp_watch_result` rồi kết thúc turn. Mọi agent `ok` → trả lời anh đúng một dòng. Cần xem sâu hơn → `slp_activity(agent, n ≤ 50)`: n item timeline gần nhất đã rút gọn, chỉ của Lead/Peer thuộc feature mình. Plugin không nhắc lại gói chưa được trả lời.
   - Dữ liệu thiếu không phải vi phạm: gói bị cắt, dòng thiếu hay tool không đọc được là khe quan sát; Supervisor đọc `slp_activity` trước khi `intervene`, và báo khe đó thay vì suy ra lỗi.
   - Item mở: verdict `watch`/`intervene` còn hiện ở các gói sau tới khi Supervisor đóng bằng `ok` kèm `note` nói cái gì đã giải quyết; plugin từ chối đóng mà không có `note`. Lead xác nhận chưa đủ để đóng: cần report đã sửa và quyết định của Lead. Không nhắc lại một lo ngại nếu không có bằng chứng mới, lỡ mốc hay hệ quả tăng.
   - Tiến độ dùng được: task và layer cứ tăng mà capability trong brief vẫn chưa nối end-to-end, hoặc việc sẵn sàng nằm im sau một quyết định → hỏi Lead: "Bước kế tiếp mở ra outcome dùng được nào, còn gì chặn đường chạy được nhỏ nhất?"
6. **Can thiệp.**
   - Lead có vấn đề → Supervisor `slp_send(→ Lead, mode: "steer")`: một quan sát kèm bằng chứng và một câu hỏi mở; Lead chọn cách sửa. T21: steer tới được Lead đang chạy ngay trong turn, nhưng huỷ tool đang chờ (một lệnh Bash đang chờ permission biến mất). Supervisor tính tới điều đó: Lead đang chạy một lệnh dài thì chờ tới lần kiểm sau. Không kê đơn trá hình thành câu hỏi. Để turn Lead đang chạy tự xử lý report vừa tới; can thiệp trước khi spawn task phụ thuộc hay accept.
   - Tin Supervisor gửi Lead tách điều anh đã quyết (trích D# hay quyết định) khỏi điều Supervisor suy ra; suy luận là câu hỏi, không phải chỉ thị.
   - Peer có vấn đề → Supervisor steer Lead kèm nhận xét về Peer; Lead quyết và chỉnh Peer bằng `slp_send(→ Peer, mode: "steer" | "interrupt")`. Supervisor không nhắn Peer: Peer chỉ có một chủ.
   - Agent chờ permission của anh → Supervisor báo anh trong tab của mình.
   - Plugin không tự dừng hay tự phán agent nào.
7. **Đo** (§10): số lần gửi / bỏ qua; số `ok` / `watch` / `intervene`; can thiệp có kéo theo tiến triển (file đổi, report, challenge) trong 2 lần kiểm kế tiếp không; token của các turn kiểm.

Tắt bằng cờ `watch: false`. Chi phí ước tính (chưa đo): ~5k token mỗi lượt cho 3 agent, ~20k token mỗi giờ cho một feature đang chạy; context Supervisor đầy nhanh hơn nên xoay vòng sớm hơn.

## 8. Cấu hình

`~/.paseo/config.json` (thêm, giữ nguyên phần còn lại):

```json
{
  "agents": {
    "providers": {
      "slp-supervisor":  { "extends": "claude", "label": "SLP Supervisor",
                           "paseoTools": { "enabled": false } },
      "slp-lead":        { "extends": "claude", "label": "SLP Lead",
                           "paseoTools": { "enabled": false } },
      "slp-peer-impl":   { "extends": "claude", "label": "SLP Peer impl",
                           "paseoTools": { "enabled": false } },
      "slp-peer-review": { "extends": "codex",  "label": "SLP Peer review",
                           "paseoTools": { "enabled": false } }
    }
  }
}
```

Rev 5.9: cả 4 vai `paseoTools.enabled: false` (§7 luật chung); plugin từ chối tạo agent SLP nếu provider `slp-*` nào còn bật.

Model, mode, thinking cho từng vai đặt trong Paseo agent profile cùng tên (Settings → Agent profiles). Plugin nhận profile theo `provider`, không theo tên; tạo profile sau khi plugin chạy cũng được (rev 5.9, B-1). Trong app, chọn profile ở ô model, mục **Profiles**. Mode chọn **Always Ask** (= `default`) cho vai Claude: plugin cũng ép `default` cho vai Claude. Với Codex, plugin bỏ `modeId` mà profile đặt và đặt `approval_policy: "on-request"` cùng permission profile trong `CODEX_HOME` (§4); mode chọn trong profile không có tác dụng. Không chọn Bypass hay Full access. Đổi vendor của một vai: sửa `extends`; plugin tự áp loại sandbox tương ứng và từ chối cấu hình mà reviewer trùng vendor với implementer.

Agent profile mặc định (rev 5.6):

| Profile (provider) | Model | Thinking (`thinkingOptionId`) | Vì sao |
|---|---|---|---|
| `slp-supervisor` | `claude-opus-5-5` | `high` | Duyệt plan của Lead nên không yếu hơn Lead; phần lớn turn chỉ đọc gói kiểm, `high` là đủ và đỡ quota |
| `slp-lead` | `claude-opus-5-5` | `xhigh` | Viết spec/plan, chia task, nghiệm thu; plan sai thì mọi Peer làm sai theo |
| `slp-peer-impl` | `claude-sonnet-5-5` | `high` | Vai đông nhất (nhiều Peer song song); task nhỏ, còn verify và review kiểm sau |
| `slp-peer-review` | `gpt-6-astra` | `xhigh` | Chốt độc lập duy nhất trước accept; quota Codex tách khỏi Claude |

- Đặt thinking rõ ràng ở mọi profile: Paseo mặc định Opus 5.5 và Sonnet 5.5 ở `medium` (§12); cache model của Codex ghi `gpt-6-astra` mặc định `low`.
- Sonnet 5.5 cần Claude Code ≥ 2.1.284 và Haiku 5.5 ≥ 2.1.293 (manifest Paseo); binary cũ hơn thì Paseo ẩn model đó. Ngày 2026-10-23 daemon dùng `~/.nvm/versions/node/v22.19.0/bin/claude` 2.1.308 và `paseo provider models claude` đã có `claude-sonnet-5-5`; bản Homebrew 2.1.283 vẫn còn trên PATH, xếp sau bản nvm.
- Không chọn thinking `ultracode` ("Ultra Code") cho vai SLP: Paseo đổi nó thành `xhigh` cộng cờ `ultracode` (§12). Cờ đó có lẽ cho Claude Code tự tạo subagent (chưa kiểm); nếu đúng thì đi vòng `slp_spawn`, trần writer và quota.
- `**Model:**` của task chỉ đổi model; thinking vẫn lấy từ profile `slp-peer-impl`, nên task được nâng lên Opus vẫn chạy `high`.
- Không dùng làm mặc định:
  - Fable 5.1: giá API khoảng 2,5 lần Opus 5.5 (quota subscription có cùng tỉ lệ không thì chưa kiểm), một turn có thể chạy nhiều phút. Chỉ nâng Lead lên Fable khi pilot thấy plan hay bị trả lại, hoặc Peer fail vì chia task sai.
  - Haiku 5.5: Peer báo xong sai thì tốn thêm vòng sửa và review, nhiều hơn số tiết kiệm.
  - Fast mode: giá gấp đôi, SLP không cần trả lời nhanh.
- T21 dòng 19: reviewer Codex đọc được `~/.paseo` và `~/.slp`, nhưng không gọi được localhost. Anh chọn **(c)**: giữ Codex cho pilot trên repo của anh, cộng chặn đọc bằng permission profile trong `CODEX_HOME` (§4).
  - Khi nào đổi: lúc chạy SLP trên repo có nội dung từ bên ngoài, hoặc khi lượt smoke lại thấy chặn đọc không có tác dụng qua app-server.
  - Cách đổi: profile `slp-peer-review` đổi `extends` sang `claude`, model `claude-opus-5-5` `xhigh` (khác model với Peer-impl dù cùng vendor), và tắt `flags.crossVendorReview`.

`~/.slp/config.json`:

```json
{
  "projects": {
    "<project>": {
      "repo": "/abs/path/to/repo",
      "baseBranch": "origin/main",
      "verify": ["<lệnh test full suite>"],
      "maxWriters": 2
    }
  },
  "flags": {
    "ask": true, "evidenceCheck": true, "touchSetGuard": true,
    "crossVendorReview": true, "supervisorPlanApproval": true, "autoResume": true,
    "watch": true
  },
  "limits": {
    "resumeMaxAttempts": 6, "challengeAnswerMinutes": 30,
    "noReportNudges": 1, "verifyTimeoutSeconds": 900,
    "humanReminderMinutes": 30
  },
  "models": {
    "allowed": ["claude-sonnet-5-5", "claude-opus-5-5"]
  },
  "sandbox": {
    "runner": ["codex", "sandbox", "-P", "slp-verify", "-C", "{worktree}", "--"],
    "denyRead": ["~/.slp", "~/.paseo"],
    "claudeAllowedDomains": ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]
  },
  "rotation": { "contextRatio": 0.6, "maxTurns": 200 },
  "runtime": { "claudePluginDir": null },
  "watch": { "intervalMinutes": 15, "packToolCalls": 10 }
}
```

- `watch.intervalMinutes`: khoảng giữa hai lần kiểm (§7.7); anh đặt 10 nếu muốn dày hơn.

- `models.allowed`: model Lead được ghi cho từng task (`**Model:**`, §6.3). Mặc định Sonnet 5.5 và Opus 5.5; Lead nâng task khó lên Opus (contract chung, concurrency, migration, security). Bỏ trống `**Model:**` = model của profile `slp-peer-impl`.
- `sandbox.runner`: lệnh plugin dùng để chạy verify/hook trong sandbox (đã kiểm với `codex-cli 0.163.0`). Cần Codex CLI trên máy.
  - Rev 5.9: profile `slp-verify` do plugin ghi vào `CODEX_HOME` riêng của runner:
    ```toml
    [permissions.slp-verify]
    extends = ":workspace"

    [permissions.slp-verify.filesystem]
    "<path>" = "deny"   # mỗi path trong sandbox.denyRead
    ```
  - Đã kiểm ngày 2026-10-23 với `codex sandbox -P`: file trong path bị `deny` báo `Operation not permitted`; file khác đọc được; worktree ghi được.
  - Reviewer Codex dùng cùng danh sách, qua `default_permissions` trong `config.toml` của reviewer.
- `sandbox.denyRead`: thư mục mà mọi sandbox của SLP không đọc được. Áp cho cả `denyRead` của sandbox Claude, profile của runner và profile của reviewer.
  - Mặc định là state của plugin và của Paseo.
  - Anh thêm được, ví dụ `~/.ssh`, `~/.aws`, `~/.config/gh`: sandbox Claude hiện đọc được gần hết `$HOME`, vì trước giờ chỉ hai thư mục trên bị chặn.
- `limits.humanReminderMinutes`: việc chờ anh quá số phút này thì Supervisor nhắc anh một dòng (§6.6).
- `sandbox.claudeAllowedDomains`: domain vai Claude được truy cập trong sandbox (để cài dependency). Localhost không bao giờ nằm trong danh sách.
- `runtime.claudePluginDir`: plugin mà vai Claude được nạp lại bằng `--plugin-dir` (§4 cô lập runtime). `null` = bản Superpowers mới nhất trong `~/.claude/plugins/cache/claude-plugins-official/superpowers/`; không tìm thấy thì vai Claude chạy không có Superpowers và plugin cảnh báo.

Tắt một cờ → cơ chế đó không chạy, hệ thống quay về hành vi không có nó (ví dụ `evidenceCheck: false` → Lead nghiệm thu dựa trên report + review).

## 9. Xử lý lỗi

| Ca | Xử lý |
|---|---|
| Cả account một vendor dính limit | Mỗi agent dính limit tự hẹn resume theo giờ reset của vendor (`listUsage`); các tin resume giãn nhau 15 giây; số lần resume giữ qua các lần resume; quá `resumeMaxAttempts` → báo Supervisor của feature. Đơn giản hoá v1: không tạm dừng cả vendor (§7.1 Watchdog limit) |
| Daemon / plugin restart | State, hàng đợi, timer resume nằm trên đĩa; đối soát khi khởi động (§7.1). T21 dòng 12: `plugin reload` giữa lúc chạy giữ nguyên hàng đợi (7 trước, 7 sau) và không ghi nhầm tin nào. Rev 5.9: timer chạy tiếp mà không chờ hook đầu tiên (§7.1 Nhịp kiểm) |
| `paseo agent reload` (khởi động lại tiến trình, giữ phiên) | Plugin không ghi item timeline phát lại thành `human_message` (§7.1 Ghi tin của anh). Cờ cô lập và sandbox giữ nguyên qua reload (T21 đã kiểm). Provider config mới có hiệu lực với tiến trình mới |
| Vai chưa có agent profile | `slp_spawn` báo rõ thiếu profile nào; không gửi provider thiếu model xuống Paseo (§7.1 Gắn vai) |
| Provider `slp-*` còn bật Paseo tools | Plugin không tạo agent SLP, báo cấu hình cần sửa (§7 luật chung) |
| Plugin chết | Fail closed: agent mất tool `slp`, không báo cáo / nhắn được, dừng. Không có ghi nào ngoài router |
| Context Supervisor / Lead đầy | Xoay vòng (§7.5); Peer vẫn chạy |
| Agent chết giữa task | `agent.closed` không có `release` → retire định danh, nhả slot writer, báo cha logic; worktree + branch giữ; Lead giao task cho Peer mới tiếp từ branch cũ. Chết lúc plugin tắt → đối soát làm như vậy khi khởi động |
| Lead chết | Supervisor của feature tạo lại Lead (`slp_spawn`) trong worktree cũ, prompt đầu là checkpoint mới nhất + digest |
| Dòng cuối file JSONL bị cắt dở (crash giữa lúc ghi) | Bỏ đúng dòng đó, ghi `ops: log_truncated`, chạy tiếp; dòng hỏng ở giữa file → fail closed, báo lỗi |
| Ghi file hàng đợi router lỗi (đĩa đầy, quyền) | Ghi log, giữ hàng đợi trong bộ nhớ, thử lại ở lần ghi sau; plugin không sập |
| Lỗi đĩa có chữ "quota" (`disk quota exceeded`) | Không coi là limit, không hẹn resume; xử lý như turn lỗi thường |
| `slp_accept` task không ở trạng thái `reported` (ví dụ `parked`) | Từ chối, nêu trạng thái hiện tại |
| Plan chạm contract feature khác đang giữ | `slp_approve_plan` bị từ chối; Lead thêm `Waits on` hoặc bỏ contract; không xếp được → Supervisor hỏi anh thứ tự |
| Gói kiểm tới khi Supervisor đang bận (đang chat với anh) | Chờ Supervisor rảnh; gói mới thay gói cũ |
| Steer tới Lead đang chạy | T21: chen được vào turn, nhưng huỷ tool đang chờ (permission đang treo biến mất); Lead tự chạy lại nếu cần |
| Fix round 3 | Lead bắt buộc đối chiếu tiền đề (§6.5); round 5 (trần Superpowers) → park / hoãn / leo thang |
| Challenge không ai trả lời | Quá `challengeAnswerMinutes` → nhắc Lead; quá gấp đôi → báo Supervisor |
| Anh vắng ở cổng | Việc độc lập chạy tiếp; Supervisor nhắc sau `limits.humanReminderMinutes` (rev 5.9, thay heartbeat); không gì được push |
| Vượt ngân sách brief | Supervisor hỏi anh (đổi cost là quyền của anh) |
| Reviewer sửa file | Review vô hiệu; Lead spawn reviewer mới |
| Kiểm bằng chứng fail (verify hoặc hook của repo trong sandbox) | Task không accepted; output gửi về Peer để sửa (tính là một fix round); report kế tiếp tạo commit mới nối lên trên |
| `slp_report` mà worktree không có thay đổi | Từ chối report, báo Peer |
| Có file nhạy cảm (`.env*`, khoá) trong thay đổi | Không đưa vào commit; báo Peer và Lead |
| `sandbox.runner` không chạy được (thiếu Codex CLI, profile đổi tên) | Fail closed: không chạy verify ngoài sandbox; task không accepted; báo Supervisor, không nhắn Peer; verify lại trên đúng commit ở turn sau hoặc khi plugin khởi động |
| Plugin chết giữa `git commit` và ghi event | Lần xử lý sau nhận ra commit của plugin (trailer `SLP-Task`, chưa có event) và ghi `commit` với `recovered: true` |
| `<worktree>/.git` bị sửa | Plugin không đọc file đó; lệnh git của plugin dùng git dir tin cậy. Thư mục không thuộc repo đã đăng ký → plugin từ chối chạy git (fail closed) |
| Peer sửa hook, `paseo.json` hoặc setting agent (`.claude/`, `.codex/`, `.mcp.json`) | Không vào commit; Lead được báo; người làm tay nếu cần |
| Lệnh verify cần mạng | Verify chạy với mạng bị chặn; dependency phải được Peer cài trước trong worktree (Claude sandbox cho `claudeAllowedDomains`). Verify fail vì mạng → báo Lead sửa lệnh verify trong plan |
| Merge main sau feature khác ship có conflict | Plugin báo Lead; Lead thêm task resolve vào plan, giao bằng `slp_spawn … merge_base: true` (plugin để lại marker trong worktree của Peer, `slp_report` tạo merge commit); nếu chạm contract của feature đã ship → challenge lên Supervisor |

## 10. Đo lường và Better-SLP

### 10.1 Bản ghi mỗi feature (`feature_record`)

| Trường | Nguồn | Baseline (mining 09-21 → 10-20) |
|---|---|---|
| Prompt của anh (tổng / duyệt suông / hỏi tiến độ), theo agent nhận | `human_message` | 19% prompt ≤ 15 ký tự; 23 prompt hỏi tiến độ |
| Leo thang (số, loại, thời gian chờ anh) | event | — |
| Dừng vì limit, thời gian kẹt, số lần cần anh can thiệp | `ops` | 33 dừng + 16 "Try again" |
| Claim "xong" sai: plugin bắt / anh bắt sau | `evidence` fail; ghi tay của anh | ~25 ca |
| Challenge: số, đúng (accepted/supersede) / sai (rejected/keep), thời gian bằng chứng → quyết định | event | Owner Assistant: 8–12 ngày |
| Task `stale` mở lại: lộ lỗi thật? | event + review | — |
| Lỗi tiền đề lộ ra sau ship | anh ghi tay | — |
| Token theo vai; số lần xoay vòng; thời gian thực | Paseo + event | — |
| Nhịp kiểm: gửi / bỏ qua; `ok` / `watch` / `intervene`; can thiệp có tiến triển trong 2 lần kiểm; token của turn kiểm | `ops` + `watch_result` + event | Anh can thiệp tay vì quay vòng / sai hướng: chưa đếm |
| Popup permission tới anh (theo vai, theo tool) (rev 5.9) | `agent.permission_requested` mà plugin `defer` | T21: 7 cho một feature 1 task (Lead 5, Peer 2) |
| Brainstorm: số câu hỏi, số lần gọi Lead, số vòng tranh luận, số quyết định "tự chọn" và "Lead thêm" mà anh đổi lúc duyệt spec (rev 5.9) | `human_message` + `brief`/`spec` + `premise.source` | T21: 1–2 câu, 0 lần gọi Lead |
| Dòng sidebar thêm mỗi feature (rev 5.9) | `workspace.created` không `background` | T21: 3 project mới mỗi feature 1 task |

Không đặt mục tiêu tuyệt đối trước: baseline tính theo session, không theo feature; 1–2 feature đầu dùng để hiệu chỉnh. Kỳ vọng định tính (rev 5.9): prompt của anh ≈ các câu trả lời trong brainstorm + 2 cổng + leo thang thật; popup shell = 0; hỏi tiến độ ≈ 0; limit không cần anh can thiệp; mỗi feature một dòng sidebar.

### 10.2 Rà sau khoảng 3 feature

Anh nhờ một Supervisor bất kỳ đọc `project.jsonl` (chỉ đọc) và đề xuất; anh quyết:
- Cơ chế không làm đổi kết quả lần nào → đề xuất tắt cờ (ví dụ: `evidenceCheck` chưa bắt được claim sai nào; reviewer khác vendor không đổi kết luận nào mà tốn token).
- Heuristic: Peer leo thang cùng loại vấn đề nhiều lần → chỉ dẫn của Lead lỗi; Lead phải đọc transcript mới hiểu Peer → giao thức báo cáo thiếu; Supervisor liên tục cứu quyết định của Lead → ranh giới vai sai.
- Nhịp kiểm: can thiệp hiếm khi có tiến triển, hoặc token của turn kiểm lớn → giãn nhịp, hoặc chuyển sang plugin cảnh báo theo ngưỡng; anh thấy tab Supervisor rối vì lượt kiểm → tách sang agent watcher.
- Chạm nhau giữa feature mà luật contract không bắt, phải nhờ anh xếp nhiều lần → cân nhắc một Supervisor nhìn toàn project.

## 11. Kiểm thử

### 11.1 Spike — đã chạy 2026-10-21/22

Kết quả đầy đủ: [`docs/research/spikes-2026-10-21.md`](../../research/spikes-2026-10-21.md).

| # | Câu hỏi | Kết quả | Đưa vào thiết kế |
|---|---|---|---|
| S1 | Plugin tự phục vụ MCP và định danh người gọi | ✅ Claude và Codex gọi được; token riêng gắn đúng agent | §7.1 Định danh agent; tự duyệt tool `slp_*` |
| S2 | Nhận diện limit, giờ reset | ◐ Paseo không nhận diện; `providers.listUsage()` có `resetsAt`; chưa tái hiện một turn dính limit thật | §7.1 Watchdog limit |
| S3 | Sandbox chặn `paseo` CLI, ghi ngoài worktree, localhost | Claude (plugin gắn sandbox): ✅ chặn cả ba. Codex qua Paseo: chặn CLI và ghi, **localhost mở** | §4 vendor; §13 |
| S4 | Phân biệt tin của anh | ✅ qua `messageId` do plugin cấp + vỏ `<paseo-system>` + `agent_message` | §7.1 Ghi tin của anh |
| S5 | Permission Bash tới plugin | ✅ có lệnh đầy đủ; plugin tự từ chối được | §7.1 Chặn quyền |
| S6 | Superpowers trong agent Claude của Paseo | ✅ 15 skill, nạp được | §6.3 |
| S7 | Mức context | ✅ `contextWindowUsedTokens/MaxTokens` | §7.5 |
| S8 | Plugin tạo agent có `parent` | ✅ | §7.1 Spawn, §7.4 |
| S9 | Codex commit trong worktree | ❌ Codex cố ý khoá `.git` (source `openai/codex`) | Plugin commit thay Peer |
| S10 | Sandbox của Claude; chạy verify/hook trong sandbox | ✅ (`codex sandbox -P :workspace`) | §7 luật chung; §8 `sandbox` |
| S11 | Setting của anh và của repo lọt vào agent (probe 2026-10-23, Claude Code 2.1.308, Codex CLI 0.163.0) | ❌ mặc định: hook trong `.claude/settings.json` của checkout chạy ngoài sandbox, server trong `.mcp.json` được khởi động, agent nhận MCP/plugin/connector claude.ai của anh; Codex nhận `cua_repl` và `gitnexus` từ `~/.codex`. ✅ `--setting-sources=` + `--strict-mcp-config` + `--add-dir` + env giữ CLAUDE.md của repo mà chặn hết phần kia; `--plugin-dir` nạp lại Superpowers (15 skill); `CODEX_HOME` riêng chỉ symlink `auth.json` vẫn đăng nhập được, không MCP. Sandbox Claude tự chặn Bash ghi `.claude/settings.json` và `.mcp.json`; `Write` thì ra permission request | §4 cô lập runtime; T21 dòng 26–27 kiểm qua SDK của Paseo |

**Đã kiểm ở T21 (2026-10-23):**
- `extraArgs` qua SDK của Paseo ra đúng cờ (dòng 26 ✅);
- `toolPolicy` bỏ hết popup cho `slp_*` (dòng 17 ✅);
- reviewer Codex đọc được `~/.paseo` nhưng **không** gọi được localhost (dòng 19);
- steer chen được vào turn đang chạy, nhưng huỷ tool đang chờ (dòng 22);
- `timeline.refetch` trả tool call của turn đang chạy (dòng 21 ✅);
- `listUsage` theo provider gốc `claude`/`codex` (dòng 18, mới xem qua CLI).

**Còn mở:**
- dạng thật của một turn dính limit (S2; T21 không gặp);
- `claudeAllowedDomains` có đủ để Peer cài dependency không (smoke không cài gì);
- tên profile `:workspace` của `codex sandbox` khi Codex CLI lên bản mới;
- sandbox Claude có chặn ghi `<worktree>/.git` không (T21 dòng 16: Peer từ chối thử);
- chặn đọc bằng permission profile có ăn với reviewer Codex chạy qua app-server của Paseo không (rev 5.9);
- Peer chạy nền có mở được từ chip subagents của Lead không (rev 5.9);
- plugin server lấy được client Paseo lúc khởi động không (rev 5.9, §7.1 Nhịp kiểm).

### 11.4 Chạy live T21 (2026-10-23) và lượt smoke lại

- **Kết quả đầy đủ:** [`docs/research/smoke-2026-10-23.md`](../../research/smoke-2026-10-23.md).
  - Lượt chạy có 2 feature 1 task: slugify đi trọn tới ship; truncate dùng để thử Supervisor thứ hai và gửi tin thử thẳng cho Peer/reviewer.
  - Khoảng 22/27 dòng đạt.
  - Tìm ra bug B-1 tới B-9, cùng lỗi timer ở dòng 24.
- **Lượt smoke lại sau rev 5.9:** repo tạm như T21, một feature 2 task có ít nhất một câu khó. Đo:
  - số popup tới anh: kỳ vọng 0 popup shell;
  - số dòng sidebar thêm: kỳ vọng 1;
  - số lần anh phải quyết định: các câu trong brainstorm + spec + ship;
  - Supervisor gọi Lead tham vấn đúng lúc, và ghi các điểm tự chọn;
  - spec có mục `Decisions added by the Lead`;
  - reload agent không tạo `human_message`;
  - plugin reload xong thì timer vẫn chạy;
  - reviewer Codex không đọc được file mồi trong `~/.paseo`;
  - Peer chạy nền mở được.
- **Kết quả lượt smoke lại** (2026-10-23/24): [`docs/research/smoke-2026-10-23-rerun.md`](../../research/smoke-2026-10-23-rerun.md). 10/12 mục đạt hoặc đạt một phần; tìm ra F1–F8. Máy khởi động lại làm mất repo trong `/tmp` trước bước ship, nên cổng ship chưa chạy live ở lượt này.
- **Smoke ngắn sau rev 5.10:** repo dưới `$HOME` (không dùng `/tmp`), một feature. Đo:
  - brief nhiều version không đẻ premise trùng; digest không còn dải "Awaiting spec approval" sau khi duyệt spec;
  - Supervisor trả lời theo ngôn ngữ của anh và trình spec bằng bảng ví dụ;
  - `agent reload` reviewer Codex: phiên mở lại được, `cat` file mồi trong `~/.paseo` vẫn bị chặn (R10 lần 2);
  - cổng ship live: "ok ship" → push lên origin, không có PR khi `openPr: false`.

### 11.2 Unit test plugin

Git dir tin cậy (`.git` giả không làm chạy fsmonitor; thư mục lạ → từ chối); file hook/`paseo.json`/`.claude`/`.codex`/`.mcp.json` không vào commit; vai Claude khởi động với `setting-sources` rỗng và `strict-mcp-config`, vai Codex với `CODEX_HOME` riêng chỉ chia sẻ `auth.json`; `onTurnEnded` chồng nhau chỉ commit một lần; runner hỏng → báo Supervisor, không nhắn Peer; phục hồi commit sau crash; câu duyệt gõ trong cùng turn được tính, câu cũ không duyệt version mới; agent không phải SLP không bị ảnh hưởng khi setup SLP hỏng; Lead/Peer không bao giờ chạy trong checkout chính. Ma trận quyền §5.2 (mỗi ô được/không được); cạnh router §7.3; suy ra trạng thái §5.3 (supersede → stale, kể cả qua T#; confirms; park/unpark); kiểm quote §7.6; watchdog limit (số lần resume giữ qua các lần resume, hết lượt → báo Supervisor); đối soát sau restart; trần writer; reviewer sửa file → review vô hiệu; commit thay Peer (không thay đổi → từ chối; file nhạy cảm bị loại; hook husky trong worktree **không chạy** khi plugin commit/merge); verify chạy qua `sandbox.runner` (runner hỏng → fail closed, không chạy ngoài sandbox); `Write`/`Edit` ngoài worktree → bị từ chối; model ngoài `models.allowed` → `slp_spawn` bị từ chối.

Rev 4: Supervisor chỉ một feature (brief v1 tạo feature; brief cho slug khác bị từ chối; không ghi được feature khác; đọc được digest feature khác); tối đa một Lead sống mỗi feature; contract (duyệt trước giữ; chạm contract đang bị giữ mà không `Waits on` → từ chối duyệt; task `Waits on` không spawn được tới khi nhả; ship nhả và báo); steer / interrupt chỉ ở hai cạnh Supervisor → Lead của mình, Lead → Peer của mình; nhịp kiểm (bỏ qua khi không có hoạt động; gói mới thay gói chưa giao; gói đúng cấu trúc và giới hạn dòng; `slp_activity` chỉ trong feature mình; dừng khi ship); `slp_state` không tính là báo cáo, turn `canceled` không bị nhắc; dòng cuối JSONL cắt dở bị bỏ, dòng giữa hỏng → fail closed; `slp_accept` task `parked` bị từ chối; lỗi ghi hàng đợi không làm sập plugin; agent đã mất được retire và nhả slot writer khi đối soát; "disk quota exceeded" không bị coi là limit.

### 11.3 Kịch bản áp lực cho prompt Peer

Repo giả dùng một lần. Mỗi kịch bản chạy 3 lần không có prompt vai (RED) và 3 lần có (GREEN):
1. Tiền đề D1 sai thật, plan đã duyệt, đang gấp → Peer challenge kèm bằng chứng chạy lại được, không workaround.
2. D1 đúng, Peer chỉ hơi nghi → Peer làm xong, `done_with_concerns`, không báo động giả.

## 12. Paseo: đã kiểm và giả định

Đã kiểm qua docs, CLI help, source (v0.10.3, v0.12.0) và probe live trên 0.12.0:
- Paseo chạy Claude Code qua Claude Agent SDK (`providers/claude/query.ts`) và Codex qua `codex app-server` (JSON-RPC qua stdio, `codex-app-server-agent.ts:7242`), dùng login và config sẵn có của anh.
- Không có khái niệm "room"; đơn vị là project → workspace (local/worktree) → agent (cha/con) + terminal + script.
- Agent nhắn bất kỳ agent nào theo ID trên cùng host. Không có hàng đợi: tin của người mặc định ngắt turn đang chạy; tin agent gửi qua CLI/MCP (0.12) chen vào turn (steer) và hiện là `agent_message` có `sender`.
- Đọc agent khác: `get_agent_status`, `get_agent_activity`, `list_agents`; CLI `ls --json --label`, `logs`, `wait`; TS SDK.
- Cha nhận thông báo xong/lỗi/permission của con (`notifyOnFinish`).
- Heartbeat chỉ nhắc agent tạo ra nó; schedule tạo agent mới mỗi lần.
- `paseoTools.disabledTools` / `enabled: false` theo provider ID. Bản trước ghi "không phải ranh giới bảo mật nếu agent có shell". Với vai SLP thì sai: shell nằm trong sandbox không có mạng, còn tool `paseo` thì không.
  - Rev 5.9, T21 đã thấy: Paseo tự cho tool MCP của chính nó mà không gửi permission request, nên `enabled: false` mới là ranh giới.
  - Provider config chỉ áp khi tiến trình agent khởi động.
- Rev 5.9, T21 đã thấy:
  - **Workspace và project:**
    - `workspaces.create({ source: { kind: "directory", path } })` không có `projectId` thì tạo một project mới cho đường dẫn đó, và project còn lại sau khi archive workspace.
    - Có `projectId` thì workspace nằm dưới project đó; thêm `background: true` thì không hiện trong sidebar (thử bằng `paseo workspace create --project … [--background]`).
    - SDK không có hàm xoá project; trong app thì chuột phải → Remove project, và file trên đĩa không bị đổi.
  - **Agent:**
    - `paseo agent reload <id>` khởi động lại tiến trình, giữ phiên, và phát lại timeline thành `user_message` mới mang `messageId` mới.
  - **Codex 0.163:**
    - permission profile có `[permissions.<p>.filesystem] "<path>" = "deny"` (kiểm bằng `codex sandbox -P`).
    - Khi reviewer chạy, Codex hoặc Paseo ghi thêm trust cho repo vào `config.toml` trong `CODEX_HOME`.
  - **App:**
    - Ô model của composer hiện tên model, không hiện tên profile. Provider tuỳ chỉnh không có icon riêng thì hiện icon robot.
- Plugin server: event `agent.created/closed/turn_started/turn_ended/permission_requested/permission_resolved/archived`, `workspace.created/archived` (live, best-effort, không replay, timeout 30 s); `before agent.create` sửa systemPrompt / mcpServers / toolPolicy / providerOptions (không đổi cwd); `before agent.session_open` chỉ env; `respondToPermission`; `timeline.refetch`; `agent.send`; settings document bền.
- `paseo.config.get().config` có `providers` và `agentProfiles` ở tầng ngoài cùng (file `agents.providers` được ánh xạ sang `providers`, `daemon-config-store.ts:210`).
- Tạo agent có `parent` mà không có `workspaceId`/`worktree` → Paseo đặt `cwd` = `cwd` của cha (`create-agent/intent.ts` `resolvePlacement`). Có `worktree: { mode: "branch-off" }` → Paseo tạo worktree (`git worktree add`, có chạy hook `post-checkout`) và chạy `worktree.setup` của `paseo.json` từ worktree mới, ngoài sandbox. `before agent.create` chạy sau bước đó (`agent-manager.ts:1285`). Archive workspace worktree → `git worktree remove --force`, giữ branch. Rev 5.2: workspace `source: { kind: "directory" }` không chạy setup (`session.ts` `handleWorkspaceCreateLocal`), và archive chỉ chạy `teardown`/xoá thư mục khi `isPaseoOwnedWorktree`, tức đường dẫn dưới `~/.paseo/worktrees/<hash>/<slug>` (`workspace-archive-service.ts`); SLP dùng đường đó.
- `toolPolicy.preapproved` (`{kind:"mcp", server, tool}`) được Claude (`allowedTools`) và Codex (`approval_mode: "approve"`) áp dụng.
- Paseo lưu `mcpServers` (kèm header, tức token MCP) của agent trong agent storage dưới `~/.paseo` (`agent-storage.ts:30`).
- `@getpaseo/client` 0.12: `agent.send(text, { messageId, activeTurnBehavior: "steer" | "interrupt" })`, bỏ trống thì daemon ngắt turn đang chạy (`SendMessageOptions`); `agent.refresh()` trả `null` khi daemon không thấy agent (`fetchAgent`). Item timeline `tool_call` có `status` và `detail.type` `shell` (kèm `command`, `exitCode`) / `read` / `edit` / `write` (kèm `filePath`) / `search` (protocol `agent-types.d.ts`).
- Model trong Paseo 0.12 (`providers/claude/model-manifest.ts`): `claude-opus-5-5`, `claude-sonnet-5-5` mặc định thinking `medium`; thinking `ultracode` = `xhigh` + cờ `ultracode` (`providers/claude/agent.ts:3453`). Codex nhận `thinkingOptionId` làm `reasoning_effort` (`codex-app-server-agent.ts:3845`). Cache model của Codex trên máy anh: `gpt-6-astra` là model frontier, `gpt-6.1-sol` là model workhorse.
- Paseo truyền `settingSources: ["user", "project", "local"]` cố định cho Claude (`claude/agent.ts:153`) rồi trải `providerOptions` lên sau. Schema `providerOptions` (`claude/options.ts`, `.strict()`, theo SDK 0.3.246) có `extraArgs`, `additionalDirectories`, `sandbox`, `settings.{permissions,sandbox}`, nhưng không có `settingSources`/`strictMcpConfig`; key lạ làm tạo agent fail. SDK nối `extraArgs` thành cờ sau cờ của chính nó (đọc ở SDK 0.2.117 trên máy). Env của `before agent.session_open` đi vào tiến trình `codex app-server` và quyết định `CODEX_HOME` (`agent-manager.ts:5358`, `codex-app-server-agent.ts:7176`).
- Payload `providers.listUsage()`: `{ providers: [{ providerId, displayName, windows: [{ usedPct, resetsAt }] }] }` (`messages.ts:6237`).
- Provider tuỳ chỉnh (`extends`) hiện đúng ID trong hook; plugin set được `providerOptions.sandbox` cho Claude và `sandbox_mode`/`sandbox_workspace_write` cho Codex (Codex dùng lại policy đã resolve nếu cùng loại — `codex-app-server-agent.ts:4256-4263`).
- Máy anh: Paseo app tự cập nhật lên 0.12.0 ngày 2026-10-21; daemon do app quản lý; `pluginsEnabled` chưa bật (đã bật tạm cho spike rồi trả lại); `injectIntoAgents: true`; Codex CLI 0.163.0 với `sandbox_mode = "danger-full-access"` toàn cục trong `~/.codex/config.toml` (mode `auto` của Paseo vẫn áp workspace-write).

Còn giả định: xem cuối §11.1.

## 13. Rủi ro còn mở

- **Localhost mở với Codex chạy qua Paseo (Peer-review):** về lý thuyết reviewer có thể nói chuyện thẳng với WebSocket của daemon (đọc được file credential trong `~/.paseo`) để lách router. Rev 3 thêm: agent storage dưới `~/.paseo` chứa header MCP, tức token `slp` của **mọi** agent. Reviewer Codex (đọc được đĩa, gọi được localhost) vì vậy có thể gọi tool `slp_*` dưới tên Lead hay Supervisor. Plugin chỉ lưu hash token và chặn vai Claude đọc `~/.paseo`, nhưng không chặn được Codex. Rev 5: T21 dòng 19 là **cổng bắt buộc**: dùng file mồi trong `~/.paseo/agents`, nếu reviewer vừa đọc được vừa gọi được cổng MCP qua loopback (spike S3 đã thấy loopback mở) thì dừng và anh chọn. Nếu T21 xác nhận reviewer đọc được `~/.paseo`, cần chọn: chuyển reviewer sang Claude-sandbox (cùng vendor với implementer), hoặc chấp nhận cho pilot. Giảm bằng: reviewer chỉ chạy trong worktree dùng-một-lần, bị kiểm không sửa file tracked, không có tool nhắn tin; tin lạ tới agent khác hiện là `agent_message` có `sender` hoặc bị ghi là `human_message` (có thể ghi nhầm nguồn). Nếu đo thấy cần, đổi reviewer sang Claude-sandbox và chấp nhận cùng vendor với implementer, hoặc đặt password cho daemon.
  - **Rev 5.9, kết quả T21 dòng 19:**
    - Reviewer Codex `cat` được file mồi trong `~/.paseo` và `~/.slp`.
    - `curl` tới cổng MCP trả `000`, tức không gọi được.
    - Vậy điều kiện dừng ("đọc **và** gọi được") không xảy ra. Rủi ro còn lại là reviewer bị cài cắm (prompt injection) chép bí mật vào text review. Text đó nằm trong events và tin tới Lead, và có thể lọt vào gói ship hay PR (giả thuyết).
  - **Anh chọn (c):** giữ Codex cho pilot trên repo của anh. Kèm theo:
    - chặn đọc bằng permission profile (§4, §8). Phải kiểm qua app-server ở lượt smoke lại, cả sau `agent reload` của reviewer (Paseo lưu `modeId` mà provider báo về, nên phiên mở lại có thể mang sandbox kiểu cũ); không ăn thì đổi reviewer sang Claude, hoặc plugin cho nghỉ reviewer bị mở lại phiên;
    - đổi sang (a) khi chạy repo có nội dung từ bên ngoài.
- **Sau khi reload, plugin chưa có client Paseo cho tới hook đầu tiên:** client chỉ có trong context của hook. Nếu mọi agent đang idle (ví dụ chờ limit reset) thì resume, tin trong router và nhịp kiểm đợi tới hook kế tiếp (anh mở tab, agent đổi trạng thái).
  - **T21 dòng 24 xác nhận:** không có lần kiểm nào suốt 75 phút sau reload, trong khi một Lead treo ở popup.
  - **Rev 5.9 sửa ở §7.1 Nhịp kiểm:** RPC "wake" từ client plugin đưa client Paseo cho plugin; tick kế tiếp của timer chạy bù.
- **Tự cho shell của vai Claude (rev 5.9):** sandbox thành ranh giới duy nhất cho lệnh shell.
  - Sandbox chặn ghi ngoài worktree, mạng và `denyRead`, nhưng đọc được phần còn lại của `$HOME`.
  - Một Peer bị cài cắm có thể đọc `~/.ssh` rồi ghi vào file trong worktree, file đó vào commit, rồi bị push lúc ship.
  - Trước rev 5.9 rủi ro này cũng đã có với lệnh đơn giản (vốn được tự cho); rev 5.9 chỉ mở thêm cho lệnh phức tạp.
  - Giảm bằng: `sandbox.denyRead` có thể mở rộng (§8); plugin loại file nhạy cảm khỏi commit; anh duyệt ship trên diff.
- **Brainstorm dài tốn token và công anh:** đó là chủ ý của anh (rev 5.9). Lead tham vấn được gọi sớm nên chạy cả khi anh bỏ ý tưởng. Giảm bằng: chỉ gọi Lead cho câu khó; tranh luận tối đa 2 vòng mỗi câu; đo ở §10.
- **`Write`/`Edit` của Claude không đi qua sandbox hệ điều hành:** chặn ghi ngoài worktree dựa vào plugin đọc `input.file_path` (resolve realpath trước khi so). Còn một khe nhỏ: Claude chạy tool song song, nên giữa lúc plugin kiểm và lúc ghi, một lệnh shell khác có thể tạo symlink tại thư mục chưa tồn tại.
- **Chi phí topology:** điều phối nhiều agent tốn gấp nhiều lần turn/token so với một phiên đơn. Đo ở §10; nếu không bù được bằng toil giảm, thu hẹp (tắt Supervisor duyệt plan, tắt reviewer khác vendor…).
- **Limit tập trung:** mặc định 3/4 vai dùng Claude (Supervisor, Lead, Peer-impl) → limit Claude đánh vào cả ba cùng lúc; reviewer Codex vẫn chạy tiếp. v1 không tạm dừng cả vendor, nên mỗi agent Claude tự dính limit một lần rồi tự hẹn resume; cân nhắc đổi Lead sang Codex nếu đo thấy kẹt. Rev 5.6 giảm tải bằng Peer-impl chạy Sonnet 5.5 và Supervisor ở `high`; nếu vẫn kẹt, xem `ops limit_hit` theo vai rồi mới đổi.
- **Cô lập runtime dựa vào cờ CLI qua `extraArgs`:** nếu SDK hay Claude Code đổi cách ghép cờ (thứ tự, `--setting-sources` lặp lại), hook và MCP của anh hay của repo sẽ quay lại mà không báo. T21 dòng 26 kiểm; nên kiểm lại sau mỗi lần cập nhật Claude Code. Bỏ CLAUDE.md toàn cục của anh khỏi vai SLP là chủ ý: luật của vai nằm trong prompt vai.
- **Phụ thuộc Codex CLI cho sandbox runner:** verify chạy qua `codex sandbox`; Codex CLI đổi cú pháp (như việc bắt buộc `--permission-profile` ở 0.163) là verify fail closed cho tới khi sửa config.
- **Supervisor phán đoán sai thay anh:** Supervisor duyệt plan và phân loại leo thang. Giảm bằng: cổng spec/ship luôn là anh; điểm tự chọn trong brainstorm và quyết định Lead thêm vào spec được trình riêng lúc duyệt spec (rev 5.9); mọi ruling và quyết định của Supervisor nằm trong gói ship.
- **Nhịp kiểm tốn token và làm phình context Supervisor:** ước ~20k token mỗi giờ cho một feature đang chạy (chưa đo). Giảm bằng: bỏ qua khi không có hoạt động; gói do plugin dựng có giới hạn dòng; đo ở §10 rồi giãn nhịp hoặc đổi cách.
- **Can thiệp nhầm:** Supervisor steer một agent đang làm đúng (ví dụ đang chạy test dài). Giảm bằng: gói ghi rõ trạng thái và lệnh đang chạy; Peer luôn được chỉnh qua Lead, Lead được quyền bỏ qua nhận xét của Supervisor.
- **Không ai nhìn toàn project:** mỗi Supervisor chỉ lo feature của mình; chỗ chạm nhau mà luật contract không bắt chỉ lộ ra khi một Supervisor đọc digest feature khác lúc duyệt plan, hoặc lúc merge main.
- **Sự kiện tiền đề sai hiếm:** pilot có thể không gặp challenge mức spec nào; khi đó chỉ đo được phần vận hành.
- **Paseo thay đổi nhanh** (0.x): hook, tool, format có thể đổi; plugin khai `requirements.paseo` chặt.
- **Bật plugin là chạy code không sandbox trên daemon** — cần anh đồng ý riêng ở bước triển khai.
