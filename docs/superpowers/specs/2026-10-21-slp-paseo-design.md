# SLP trên Paseo — Design spec

- Ngày: 2026-10-21 (rev 2: 2026-10-22, gộp kết quả spike)
- Trạng thái: draft rev 2, chờ review
- Paseo đã kiểm: 0.12.0 đang chạy (source v0.10.3 + v0.12.0, CLI, và probe live — xem [`docs/research/spikes-2026-10-21.md`](../../research/spikes-2026-10-21.md))
- Superpowers đang cài: 6.4.1
- Nền: báo cáo "Tinh túy Superpowers và SLP" (2026-10-09), spec SLP cũ `~/.agents/skills/slp/docs/spec.md` (không có Supervisor), mining transcript + git 2026-09-21 → 10-20, ghi chú [`docs/research/paseo-capabilities-verified.md`](../../research/paseo-capabilities-verified.md).

**Core mechanism:** anh chat với Supervisor → Supervisor viết brief, anh duyệt → Supervisor tạo Lead cho feature → Lead viết spec (anh duyệt) và plan (Supervisor duyệt) → Lead giao từng task cho Peer-impl trong worktree riêng, trong sandbox → mọi tin nhắn, báo cáo, challenge đi qua tool MCP của plugin `slp`; plugin kiểm quyền, ghi log append-only ngoài repo, commit thay Peer, chạy verify trong sandbox, tự resume khi dính limit → Supervisor gom ship, anh duyệt đúng commit hash → push + PR → anh merge.

**Decisions:**
- Supervisor là agent Paseo độc lập, đầu mối chính của anh; lo cả vận hành lẫn tiền đề/mục tiêu.
- Plugin mỏng (server-only, không UI) làm cảm biến + tay chân + người gác cổng; phán đoán để cho agent.
- 1 Supervisor / project, 1 Lead / feature, nhiều feature song song, writer tuần tự trong mỗi feature.
- Anh giữ: brief, spec, ship (theo commit hash), merge, mọi đổi goal/cost/tiền đề.
- State nằm ở `~/.slp/<project>/`, plugin là writer duy nhất.
- Feedback ngược lên là quyền có cổng bằng chứng (challenge), cộng kênh hỏi không chặn (`slp_ask`).
- Peer-impl = Claude trong sandbox của Claude Code; Peer-review = Codex. Model từng vai do anh chọn trong agent profile.
- Peer không commit; plugin commit thay Peer (hook tắt). Plugin không bao giờ chạy code do Peer viết ở ngoài sandbox.

**System impact:**
- Anh làm việc trong Paseo app (desktop/mobile), không trong Claude app, cho các feature chạy SLP.
- Daemon Paseo bật `pluginsEnabled` (code không sandbox chạy trên máy anh) — chỉ bật khi anh đồng ý ở bước triển khai.
- `~/.paseo/config.json` thêm 4 provider ID theo vai; tắt `create_agent` / `send_agent_prompt` của Paseo cho các vai đó.
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
1. **Thay anh làm Supervisor**: anh chỉ đặt goal, duyệt 3 cổng, trả lời leo thang thật.
2. **Giữ SLP**: một owner mỗi scope; quyền chất vấn tách quyền sửa; chất vấn có bằng chứng; đổi hướng đi qua shared state của Lead; goal/cost/tiền đề về tay anh.
3. **Cưỡng chế bằng cơ chế** (plugin, sandbox, provider policy), không chỉ bằng prompt.
4. **Tự chứng minh giá trị**: mỗi cơ chế đo được, tắt được.

Không gắn với project nào. Lần chạy đầu: một project mới, anh định nghĩa sau.

## 2. Quyết định đã chốt

| Chủ đề | Chọn | Lý do |
|---|---|---|
| Nền | Paseo 0.10.x, làm việc trong Paseo app | Tác giả SLP chạy trên Paseo; chỉ agent Paseo mới có plugin hook, heartbeat, thông báo |
| Supervisor | Agent LLM độc lập, lo cả vận hành (A) và tiền đề/mục tiêu (B); phần máy móc do plugin làm hộ | Anh muốn Supervisor thay anh; "cheapen mechanics, never judgment" |
| Tương tác của anh | Chủ yếu với Supervisor; hỏi thẳng Lead được, thỉnh thoảng Peer | Đổi hướng ở Lead/Peer phải được ghi vào state |
| Cổng của anh | Brief, spec, ship (theo commit hash); merge luôn do anh | Supervisor duyệt plan trở xuống |
| Ship | Gom một lần cuối feature: diff tóm tắt, bằng chứng chạy lại trên đúng commit, rulings, giả thuyết còn mở | Một lần duyệt có bằng chứng thay cho nhiều "commit"/"ok" |
| Kiến trúc | Plugin mỏng server-only + file state + prompt theo vai | Phương án 2/3; UI để sau khi có số liệu |
| Số Supervisor | 1 / project; phạm vi là tham số config; xoay vòng khi context đầy | Giá trị riêng của Supervisor (một đầu mối, thấy xung đột giữa feature, giữ goal thống nhất) mất nếu chia |
| Song song | Nhiều feature song song (mỗi feature 1 Lead, 1 worktree); writer tuần tự trong feature | Scope tách rời thật mới song song |
| State | `~/.slp/<project>/`, append-only JSONL, plugin là writer duy nhất | Bền qua run; không để dấu vết trong repo |
| Feedback ngược | Challenge có bằng chứng ở mọi tầng + `slp_ask` không chặn | Lõi khác biệt của SLP |
| Pilot | Project mới, anh định nghĩa sau; **không làm replay** | Anh chốt |
| Model | Theo Paseo agent profile của từng vai (anh chọn); mặc định Supervisor/Lead mạnh nhất, Peer-impl mid-tier. Lead được chọn model cho từng task trong danh sách anh cho phép (`models.allowed`), Supervisor duyệt khi duyệt plan | Anh đổi model một chỗ; vẫn chỉnh được theo độ khó task |
| Vendor | Supervisor, Lead, Peer-impl = Claude; Peer-review = Codex. Đổi được qua `extends`; ràng buộc: reviewer khác vendor với implementer | Sandbox Claude do plugin gắn chặn được cả localhost (S10a); sandbox của Codex chạy qua Paseo thì không (S3) |
| Commit | Peer không commit; plugin commit thay Peer lúc `slp_report`, luôn tắt hook | Sandbox giữ `.git` chỉ đọc (Codex cố ý, S9); plugin biết chắc commit hash để verify/review/merge |
| Chạy code của Peer | Plugin chạy verify và hook của repo **trong sandbox** (`codex sandbox -P :workspace`), không bao giờ ngoài sandbox | Hook/test do Peer sửa sẽ chạy với toàn quyền nếu plugin chạy trực tiếp (S10) |

## 3. Phạm vi

**Trong v1:**
- Plugin Paseo `slp` (server-only) với các thành phần ở §7.
- 4 file prompt vai (Supervisor, Lead, Peer-impl, Peer-review).
- Mẫu provider ID cho `~/.paseo/config.json` và `~/.slp/config.json`.
- Format brief / spec / plan (§6).
- Unit test plugin, 2 kịch bản áp lực cho prompt Peer, các kiểm tra còn mở ở cuối §11.1.

**Để sau (cần số liệu pilot):** phát hiện treo/lặp theo ngưỡng; UI (workspace panel, bảng trạng thái); Supervisor xuyên project; Hub/Slack.

**Không làm:**
- Không sửa plugin Superpowers. Superpowers vẫn là lõi bằng chứng tầng code bên trong Lead/Peer (TDD, verification, review theo `BASE..HEAD`).
- Không cho nhiều Peer-impl cùng sửa trong một feature.
- Không cho agent nhắn nhau ngoài router.
- Không replay lịch sử huskit.
- Không dùng SLP cho việc nhỏ, CRUD rời rạc, UI cần cảm nhận — những việc đó chạy như bình thường ngoài SLP.

## 4. Vai, quyền và cây agent

```
Anh ──chat──► Supervisor (1 / project, sống lâu, xoay vòng được)
  ╎ hỏi thẳng (ít)        │ slp_spawn
  ├╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌► Lead A (1 / feature, worktree feat/<slug>)
  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌► Peer     │ slp_spawn
                          ├─ Peer-impl (1 task / worktree con, tuần tự)
                          └─ Peer-review (worktree dùng-một-lần tại commit cần review)
                        Lead B, Lead C … (song song, mỗi Lead một feature)
```

| Vai | Sở hữu / tự quyết | Đẩy lên | Không được |
|---|---|---|---|
| **Anh** | Goal, ưu tiên, ngân sách; duyệt brief, spec, ship; merge | — | — |
| **Supervisor** | Phỏng vấn anh → brief; duyệt plan; so touch set giữa các feature; giám sát, gỡ kẹt; phân loại leo thang; đọc kết quả kiểm bằng chứng trước ship; chuẩn bị gói ship; rà Better-SLP | Đổi goal / cost / tiền đề brief–spec → anh | Sửa code; nhắn Peer; tự duyệt brief/spec/ship thay anh |
| **Lead** | Viết spec (khoá contract) và plan; sở hữu shared state của feature; chia scope; nhận/bác challenge mức plan bằng bằng chứng; ra ruling R#; integration, nghiệm thu; quyết định merge (plugin thực hiện merge vào `feat/<slug>` và merge main vào branch, hook tắt) | Challenge chạm brief/spec, vượt ngân sách → Supervisor | Sửa trong scope đang giao cho Peer; bỏ qua challenge; đổi D#/H#; tự chạy git commit/merge |
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
- Model, thinking, mode của từng vai đặt trong Paseo agent profile cùng tên vai; anh chọn. Lead được ghi `model:` cho từng task trong plan, chỉ trong `models.allowed` (§8); plugin từ chối `slp_spawn` với model ngoài danh sách.

**Mọi vai SLP chạy trong sandbox.** Chỉ plugin chạy ngoài sandbox, và plugin không bao giờ chạy code của repo ngoài sandbox (§7, luật chung).

| Vai | Sandbox | Ghi được | Mạng |
|---|---|---|---|
| Supervisor, Lead (Claude) | Sandbox Claude Code (`providerOptions.sandbox`, `allowUnsandboxedCommands: false`) | Worktree của mình (Lead) / không gì (Supervisor); state chỉ qua tool `slp_*` | Chặn hết, kể cả localhost |
| Peer-impl (Claude) | Như trên | Chỉ worktree task; `Write`/`Edit` ngoài worktree bị plugin từ chối theo `input.file_path` | Chặn hết (đã kiểm S10a) |
| Peer-review (Codex) | Codex `workspace-write` trong worktree dùng-một-lần | Worktree đó; plugin kiểm không đổi file tracked | Localhost **còn mở** khi Codex chạy qua Paseo (S3) — rủi ro §13 |

Vai Claude chạy mode `default`: lệnh shell trong sandbox tự được cho (`autoAllowBashIfSandboxed`), mọi thứ khác (Write/Edit ngoài worktree, lệnh xin ra khỏi sandbox) thành permission request cho plugin quyết.

## 5. Shared state

```
~/.slp/
  config.json                    # §8
  <project>/
    project.jsonl                # sự kiện cấp project: Supervisor, xung đột giữa feature, ngân sách, feature_record
    supervisor/checkpoint.md     # checkpoint xoay vòng mới nhất (sinh từ state)
    features/<slug>/
      events.jsonl               # log append-only — nguồn sự thật duy nhất của feature
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
| `brief` (version + sha256) | Supervisor | goal, success criteria kiểm được, hard constraints, D#/H#, phạm vi được chất vấn, ngân sách, non-goals |
| `premise` (D#/H# mới) | Supervisor (từ brief), Lead (từ spec, chỉ hiệu lực sau khi anh duyệt spec) | H# phải có `verify_by` là phép đo có thể fail |
| `human_decision` | Supervisor (hoặc Lead nếu anh nói thẳng với Lead) | `quote`: nguyên văn lời anh; `decides`: approve brief/spec/ship (kèm sha256 hoặc commit), supersede ID, keep ID, change goal. Plugin kiểm `quote` là chuỗi con của một prompt do anh gửi (§7.6) |
| `supersede` D#/H# | Chỉ đi kèm `human_decision` | ID bị thay phải đang hiệu lực |
| `spec`, `plan` (version + sha256 + touch set) | Lead | plan: mỗi task có `Depends on`, task kiểm chứng có `Verifies` |
| `plan_approved` | Supervisor | sha256 của plan |
| `assign` / `release` | Lead (qua `slp_spawn` / `slp_accept`) | task, agent, worktree, BASE commit, model |
| `report` | Peer-impl | status (`done` / `done_with_concerns` / `blocked`), commit message đề xuất, nội dung báo cáo |
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
| `ops` | Plugin | limit_hit, resumed, no_report_nudge, touch_set_violation, agent_closed, reconcile |
| `ship_package` / `shipped` | Supervisor / plugin | commit hash, PR URL |
| `checkpoint` | Supervisor | path checkpoint |
| `feature_record` (trong `project.jsonl`) | Supervisor | số liệu §10 |

### 5.3 Trạng thái suy ra

- D#/H# **hiệu lực** khi chưa có `supersede` trỏ tới; H# **confirmed** khi có `confirms` kèm evidence; còn lại H# **open**.
- Task: `pending` → `assigned` → `reported` → `accepted`; hoặc `parked` (tiền đề đang bị challenge mức spec), `stale` (đã accepted nhưng `Depends on` — trực tiếp hoặc qua T# — một ID đã bị supersede), `reopened`, `dropped`.
- Task chỉ `accepted` khi có `commit` do plugin tạo từ `report` mới nhất, `evidence` exit code 0 trên đúng commit đó — lệnh là lệnh verify của task trong plan đã duyệt, chạy trong sandbox — và review trên đúng commit đó không còn phát hiện chặn.
- Feature chỉ nghiệm thu khi: không task `stale`/`parked`, không challenge mở, `evidence` xanh của lệnh `verify` của project (full suite) trên HEAD của `feat/<slug>`.

### 5.4 Digest

Plugin sinh lại `digest.md` sau mỗi event. Đây là thứ duy nhất Supervisor đọc thường xuyên:

```
# <slug> — phase: executing (plan v2, T5/9)
Owners: T5 → peer-impl agent_abc (worktree …, BASE 1a2b3c)
Waiting on human: —
Open challenges: C3 (T4 memory cache vs retry contract) — Lead, 12 phút
Stale: T2 (depends D2, superseded by D4)
Open hypotheses: H1 (verify by T1) 
Ops: limit_hit codex 09:12 → resume 10:05 (2/6)
Budget: 41% tokens, 0.6/2 ngày
```

## 6. Luồng làm việc

```
Anh ─ý tưởng─► Supervisor phỏng vấn (một câu một lần) → brief.v1 ──[CỔNG 1: anh duyệt brief]
  → Supervisor so với các feature đang chạy (touch set dự kiến) → slp_spawn Lead (worktree feat/<slug>)
  → Lead viết spec (khoá contract; có thể challenge brief) → Supervisor đối chiếu brief
      ──[CỔNG 2: anh duyệt spec]
  → Lead viết plan → Supervisor duyệt (touch set, thứ tự verify-trước, ngân sách)
  → vòng task, tuần tự trong feature:
      Lead slp_spawn Peer-impl (worktree con từ feat/<slug>, model trong models.allowed) + task brief
      → TDD trong sandbox → slp_report (kết thúc turn)
      → plugin: commit thay Peer (hook tắt) → chạy lệnh verify + hook của repo trong sandbox → evidence
      → Lead slp_spawn Peer-review (vendor khác, worktree dùng-một-lần tại commit) → review
      → Lead slp_accept → plugin merge vào feat/<slug> (local, hook tắt) → task tiếp
  → Lead nghiệm thu (§5.3) → Supervisor đọc evidence trên HEAD → ship_package
      ──[CỔNG 3: anh duyệt ship, theo commit hash]
  → slp_ship: push + mở PR → anh merge → các Lead khác merge main vào branch, chạy lại test
  → Supervisor ghi feature_record
```

### 6.1 Brief (Supervisor viết, anh duyệt)

Mục bắt buộc:
- Goal và vì sao.
- Success criteria kiểm được bằng máy hoặc bằng một quan sát cụ thể.
- Hard constraints **đã kiểm chứng** (mỗi cái ghi nguồn).
- Giả thuyết H# — mỗi cái có `verify-by`.
- Quyết định D# đã chốt.
- Lead được chất vấn những gì (mặc định: mọi thứ trừ goal; goal chỉ đổi qua anh).
- Ngân sách: thời gian thực, token / tiền.
- Non-goals.

Đây là handoff Supervisor → Lead của SLP: xây gì, vì sao, ràng buộc nào đã kiểm, giả định nào còn mở, quyết định nào đã chốt, Lead còn được chất vấn gì.

### 6.2 Spec (Lead viết, Supervisor đối chiếu, anh duyệt)

- **Khoá contract:** API hứa gì, input hợp lệ, invariant/state phải giữ, nghĩa của "thành công", quyền sở hữu dữ liệu, cách biểu diễn lỗi, test chứng minh hành vi.
- **Không khoá:** tên helper, vị trí file, call graph.
- Mục `## Premises` liệt kê D#/H# spec dựa vào. ID đã bị supersede phải ghi chú `— superseded by <ID>`.
- Mọi câu đóng băng ("không đổi X", "frozen", "do not tune") phải trích ID nó bảo vệ, ví dụ `Không đổi model [D3]`. Nếu ID là H# đang open, viết rõ là đang đóng băng một giả thuyết.
- Supervisor đối chiếu trước khi trình anh: mọi H# trong brief vẫn là H# (không bị viết thành sự thật); không có ràng buộc mới thiếu nguồn; spec không vượt non-goals.

### 6.3 Plan (Lead viết, Supervisor duyệt)

- Theo `superpowers:writing-plans` (đã kiểm S6: agent Claude trong Paseo nạp được Superpowers); nếu Lead đổi sang vendor không có skill, prompt vai Lead chứa format.
- Plan ghi quyết định, không ghi code (tinh thần 6.4.2): signature, assertion của test, giá trị lấy từ spec.
- Mỗi task: `**Depends on:** D#, H#, T#`; task kiểm chứng: `**Verifies:** H#`; `**Touch set:**` file/module/contract dự kiến sửa; lệnh verify; tuỳ chọn `**Model:**` (chỉ trong `models.allowed`; bỏ trống = model của profile `slp-peer-impl`).
- Global Constraints: mỗi dòng kết bằng `[D#]`, `[H#]`, `[Goal]`, `[HC]`, hoặc `[Repo]`.
- Task `Depends on` một H# open phải đứng sau task `Verifies` H# đó.
- Supervisor từ chối plan khi: thiếu thứ tự verify-trước; touch set trùng contract của feature khác mà chưa có owner contract; vượt ngân sách.

### 6.4 Song song giữa các feature

- Lúc duyệt plan, Supervisor so touch set với các feature đang chạy:
  - Trùng contract / API chung → giao contract cho đúng một Lead làm owner; Lead kia chờ owner chốt rồi mới dùng. Không xếp được thì Supervisor báo anh thứ tự.
  - Trùng file lặt vặt (i18n, registry) → cho chạy, resolve lúc merge.
- Trong lúc chạy: plugin canh touch set (§7).
- Sau khi một feature merge: plugin báo các Lead còn lại; mỗi Lead yêu cầu plugin merge main vào branch (hook tắt). Conflict → Lead giao một task resolve cho Peer-impl như task thường; sau đó plugin chạy lại verify, ghi `evidence` mới.
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

**`slp_ask` / `slp_answer`** — kênh hỏi không chặn:
- Peer → Lead, Lead → Supervisor. Plugin giao câu hỏi khi người nhận kết thúc turn (không ngắt giữa turn), giao câu trả lời ngược lại cho người hỏi.
- Q#/answer nằm trong state. Câu trả lời làm đổi hướng → Lead ghi thêm ruling hoặc challenge tương ứng.

### 6.6 Không ngồi chờ

Ngoài 3 cổng, hệ thống không chờ anh. Khi đang chờ quyết định về một tiền đề, task độc lập vẫn chạy. Khi mọi task đều kẹt, Supervisor gửi câu hỏi gom và tạo heartbeat nhắc (Paseo heartbeat trên chính Supervisor, có `expiresIn`). Supervisor không bao giờ tự trả lời thay anh ở cổng.

### 6.7 Ship

- Gói ship: diff tóm tắt (file, dòng), success criteria từng cái → bằng chứng, `evidence` của plugin trên commit ship, danh sách rulings kèm `cost_if_wrong`, giả thuyết còn open, những gì khác với brief.
- Anh duyệt bằng một câu trả lời rõ (ví dụ "ship"); không cần gõ hash. Supervisor ghi `human_decision` kèm quote và commit hash của `ship_package` vừa trình; plugin kiểm (§7.6).
- `slp_ship` push `feat/<slug>` và mở PR (gh). Merge luôn do anh.

## 7. Plugin `slp`

Server-only (`index.server.ts`), chạy trên daemon kể cả khi app đóng.

**Luật chung:**
- Agent SLP không có `create_agent`, `send_agent_prompt`, `kill_agent` của Paseo (`paseoTools.disabledTools` theo provider ID). Mọi tạo agent, nhắn tin, báo cáo đi qua MCP server `slp` do plugin inject.
- **Plugin là actor duy nhất chạy ngoài sandbox, và không bao giờ chạy code của repo ngoài sandbox.** Mọi git commit/merge của plugin chạy với hook tắt (`git -c core.hooksPath=/dev/null … --no-verify`); mọi lệnh verify và hook của repo chạy qua `codex sandbox -P :workspace -C <worktree> -- <cmd>` (S10b: chặn ghi `$HOME`, chặn localhost, exit code giữ nguyên). Lý do: hook (husky…) và test nằm trong worktree, Peer sửa được.

### 7.1 Thành phần

| Thành phần | Làm gì | Cơ chế | Chặn lỗi nào |
|---|---|---|---|
| Gắn vai | Theo provider ID: system prompt vai; MCP `slp` (http, `headers.Authorization` = token riêng của agent); mode `default` cho vai Claude; sandbox theo §4 (Claude: `providerOptions.sandbox`; Codex reviewer: `workspace-write`); `toolPolicy` cho các tool `slp_*` | `before agent.create` | Vai trôi; Peer sửa state |
| Định danh agent | Token ngẫu nhiên cho từng agent, đặt vào header MCP và `env.SLP_TOKEN`; `before agent.session_open` (có `agentId`) gắn token → agent + vai. Không dùng token chung kiểu Paseo (giả mạo được) | `before agent.create` + `session_open` (S1 đã kiểm) | Agent mạo danh vai khác |
| Tự duyệt tool của mình | Permission request cho tool `slp_*` (Claude `mcp__slp__…`, Codex `CodexMcpElicitation`) → plugin tự allow, sau đó chính tool tự kiểm quyền | `agent.permission_requested` | Permission prompt dội về anh |
| Router | Chỉ cho các cạnh ở §7.3. Paseo không có hàng đợi và mặc định **ngắt** turn đang chạy, nên plugin tự xếp hàng và chỉ giao khi người nhận `idle` (kiểm `status`/`activeTurn`); tin plugin gửi mang `messageId` dạng `slp-<uuid>` | MCP + SDK `agent.send({messageId})` | Supervisor lách Lead; ngắt giữa turn |
| Spawn | `slp_spawn`: Supervisor chỉ tạo Lead; Lead chỉ tạo Peer của feature mình; tạo workspace worktree, ghi `assign` (task, BASE, model); áp trần writer; model phải trong `models.allowed`; tạo với `parent` = agent gọi (S8: lồng vào Subagents track, cha nhận thông báo) | MCP + SDK `workspaces.create` / `agents.create({parent})` | Vai tạo sai vai; lẫn worktree; model ngoài ý anh |
| State + digest | Kiểm quyền theo §5.2 rồi append; sinh lại digest; ghi `reports/` từ nội dung tool | MCP | Ghi vượt quyền; Supervisor tràn context |
| Ghi tin của anh | `user_message` không mang `messageId` do plugin cấp và không nằm trong vỏ `<paseo-system>` → `human_message` (S4 đã kiểm). Tin agent gửi agent qua CLI/MCP hiện là `agent_message` có `sender` (0.12). Tới Lead/Peer: báo thêm Lead của feature. Tới Supervisor: chỉ ghi | `agent.turn_ended` + `timeline.refetch` | Anh đổi hướng ở Peer, Lead không biết |
| Watchdog limit | Nhận diện limit từ text cuối turn / thông báo turn fail (Paseo không tự nhận diện, S2); giờ reset lấy từ `providers.listUsage()` (`windows[].resetsAt`); cổng limit **theo vendor**; hẹn `agent.send` "tiếp tục" lúc reset; trần `resumeMaxAttempts`; hết lượt mới báo Supervisor. Lần dính limit thật đầu tiên phải được ghi nguyên văn để chỉnh bộ nhận diện | `agent.turn_ended` + timer + usage API | 33 lần dừng limit, 16 "Try again" |
| Không báo cáo | Peer kết turn mà không `report`/`challenge`/`ask` → nhắc `noReportNudges` lần, rồi báo Lead | `agent.turn_ended` | Dừng im lặng |
| Commit thay Peer | Sau `slp_report` (chờ turn của Peer kết thúc hẳn): `git status`; từ chối nếu không có thay đổi; loại file nhạy cảm (`.env*`, khoá) và báo; file ngoài touch set → vẫn commit, cờ cho Lead; `git add` + commit hook tắt, message = `T#: <message của Peer>` + trailer `SLP-Task`, `SLP-Agent` → `commit` | MCP + git (hook tắt) | Peer khai sai commit; hook chạy ngoài sandbox |
| Kiểm bằng chứng | Trên commit vừa tạo: chạy lệnh verify của task (từ plan đã duyệt) và hook pre-commit của repo nếu có, **trong sandbox**, có timeout → `evidence`. Khi nghiệm thu feature và trước ship: `verify` của project (full suite) trên HEAD, trong sandbox. Không bao giờ chạy lệnh do Peer khai | `codex sandbox -P :workspace` | ~25 claim "xong" sai |
| Merge | `slp_accept` → plugin merge branch task vào `feat/<slug>` (hook tắt); Lead yêu cầu → plugin merge main vào `feat/<slug>`; conflict → báo Lead, không tự resolve | git (hook tắt) | Hook chạy với quyền của Lead |
| Reviewer không sửa | Sau turn của Peer-review: `git status --porcelain` trên file tracked phải rỗng; nếu không → review vô hiệu, báo Lead; huỷ worktree dùng-một-lần | `agent.turn_ended` | Reviewer sửa code |
| Chặn quyền | Từ chối: shell gọi `paseo`, `git push`, `git commit`/`merge` từ agent, lệnh xin ra khỏi sandbox; `Write`/`Edit` có `input.file_path` ngoài worktree của agent (S10a đã kiểm). Permission khác: policy tự quyết, còn lại chuyển cha logic; chỉ hành động ra ngoài / không đảo được tới anh | `agent.permission_requested` (S5 đã kiểm) | Lách router; ghi ngoài scope; permission dội về anh |
| Canh touch set | Sau mỗi commit: file ngoài touch set task → báo Lead; file trong touch set feature khác → báo Supervisor | `commit` | Lấn scope; feature chạm nhau |
| Cổng ship | `slp_ship` chỉ Supervisor; chỉ khi có `human_decision` duyệt ship đúng commit hash đã qua kiểm quote | MCP | Push trước khi anh duyệt |
| Đối soát | Khi plugin khởi động: đọc state, liệt kê agent qua SDK, so khớp; giao lại hàng đợi đã lưu; nhắc agent rảnh chưa báo cáo; ghi `ops: reconcile` | khởi động plugin | Sự kiện Paseo không replay |

### 7.2 Tool MCP theo vai

Mọi vai: `slp_state(scope?)` — đọc digest / event của feature mình (Supervisor: mọi feature).

| Vai | Tool |
|---|---|
| Supervisor | `slp_brief` (ghi version), `slp_human_decision`, `slp_approve_plan`, `slp_spawn` (Lead), `slp_send` (→ Lead), `slp_answer` (cho Lead), `slp_challenge` (→ anh, dạng câu hỏi gom), `slp_ship_package`, `slp_ship`, `slp_checkpoint` |
| Lead | `slp_spec`, `slp_plan`, `slp_spawn` (Peer), `slp_send` (→ Peer của mình, → Supervisor), `slp_accept`, `slp_release`, `slp_rule`, `slp_resolve`, `slp_confirm`, `slp_answer`, `slp_ask` (→ Supervisor), `slp_challenge` (→ Supervisor), `slp_human_decision` (khi anh nói thẳng với Lead) |
| Peer-impl | `slp_report`, `slp_challenge`, `slp_ask` |
| Peer-review | `slp_review`, `slp_challenge`, `slp_ask` |

Tên tool là chỉ dẫn; plan có thể đổi tên nhưng không đổi quyền.

### 7.3 Cạnh router

```
Supervisor ⇄ Lead (mọi Lead của project)
Lead ⇄ Peer do chính Lead đó spawn
Plugin → bất kỳ (nhắc, resume, giao hàng đợi)
Không có: Supervisor → Peer, Peer → Peer, Peer → Supervisor, Lead A → Peer của Lead B
```

### 7.4 Vòng đời agent

- Supervisor: một agent Paseo do anh tạo bằng profile `slp-supervisor` trong workspace của project. Khi bắt đầu, nó tạo heartbeat cho chính nó (mặc định 30 phút): "đọc digest mọi feature; xử lý bất thường; không có gì thì kết thúc turn".
- Supervisor nhận sự kiện qua router (plugin `agent.send`), không qua thông báo cha-con.
- Lead/Peer do `slp_spawn` tạo với `parent`, nên hiện trong Subagents track của agent cha; tên dạng `[Lead] <slug>`, `[Peer T4] <slug>`.

### 7.5 Xoay vòng

- Ngưỡng: `lastUsage.contextWindowUsedTokens / contextWindowMaxTokens` ≥ `rotation.contextRatio` (đọc qua SDK `refresh()` sau mỗi turn; S7 đã kiểm). Provider nào không báo thì dùng `rotation.maxTurns`.
- Khi tới ngưỡng: agent gọi `slp_checkpoint` (việc đang dở, câu hỏi chờ anh, cam kết đã hứa với anh, feature đang theo) → plugin tạo agent mới cùng vai, prompt đầu là checkpoint + digest → archive agent cũ. Supervisor mới tự tạo lại heartbeat của mình (heartbeat gắn với agent cũ mất theo khi archive). Router chuyển địa chỉ vai sang agent mới; hàng đợi giữ nguyên.
- Luật vai không phụ thuộc compaction: plugin gắn lúc tạo; quyết định nằm trong state; mỗi lần thức dậy agent đọc lại digest.

### 7.6 Kiểm quyết định của anh

`human_decision` chỉ được ghi khi `quote` là chuỗi con của một `human_message` tới agent đang ghi, và `human_message` đó đến sau event cần duyệt (brief/spec version, câu hỏi gom, `ship_package`). Với duyệt ship: commit hash trong `human_decision` phải trùng với `ship_package` mới nhất, và HEAD của `feat/<slug>` lúc `slp_ship` vẫn là commit đó (có commit mới → phải trình gói ship mới). Mục đích: Supervisor không tự bịa được chữ "duyệt", và anh không duyệt nhầm một commit khác.

## 8. Cấu hình

`~/.paseo/config.json` (thêm, giữ nguyên phần còn lại):

```json
{
  "agents": {
    "providers": {
      "slp-supervisor":  { "extends": "claude", "label": "SLP Supervisor",
                           "paseoTools": { "disabledTools": ["create_agent", "send_agent_prompt", "kill_agent"] } },
      "slp-lead":        { "extends": "claude", "label": "SLP Lead",
                           "paseoTools": { "disabledTools": ["create_agent", "send_agent_prompt", "kill_agent"] } },
      "slp-peer-impl":   { "extends": "claude", "label": "SLP Peer impl",
                           "paseoTools": { "enabled": false } },
      "slp-peer-review": { "extends": "codex",  "label": "SLP Peer review",
                           "paseoTools": { "enabled": false } }
    }
  }
}
```

Model, mode, thinking cho từng vai đặt trong Paseo agent profile cùng tên (Settings → Agent profiles). Đổi vendor của một vai: sửa `extends`; plugin tự áp loại sandbox tương ứng và từ chối cấu hình mà reviewer trùng vendor với implementer.

`~/.slp/config.json`:

```json
{
  "projects": {
    "<project>": {
      "repo": "/abs/path/to/repo",
      "baseBranch": "origin/main",
      "verify": ["<lệnh test full suite>"],
      "maxWriters": 2,
      "supervisorScope": "project"
    }
  },
  "flags": {
    "ask": true, "evidenceCheck": true, "touchSetGuard": true,
    "crossVendorReview": true, "supervisorPlanApproval": true, "autoResume": true
  },
  "limits": {
    "resumeMaxAttempts": 6, "challengeAnswerMinutes": 30,
    "noReportNudges": 1, "verifyTimeoutSeconds": 900
  },
  "models": {
    "allowed": ["claude/<model mid-tier>", "claude/<model mạnh>"]
  },
  "sandbox": {
    "runner": ["codex", "sandbox", "-P", ":workspace", "-C", "{worktree}", "--"],
    "claudeAllowedDomains": ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]
  },
  "rotation": { "contextRatio": 0.6, "maxTurns": 200 },
  "heartbeat": { "supervisorCron": "*/30 * * * *" }
}
```

- `models.allowed`: model Lead được ghi cho từng task; giá trị thật anh điền khi cài.
- `sandbox.runner`: lệnh plugin dùng để chạy verify/hook trong sandbox (đã kiểm với `codex-cli 0.163.0`, profile dựng sẵn `:workspace`). Cần Codex CLI trên máy.
- `sandbox.claudeAllowedDomains`: domain vai Claude được truy cập trong sandbox (để cài dependency). Localhost không bao giờ nằm trong danh sách.

Tắt một cờ → cơ chế đó không chạy, hệ thống quay về hành vi không có nó (ví dụ `evidenceCheck: false` → Lead nghiệm thu dựa trên report + review).

## 9. Xử lý lỗi

| Ca | Xử lý |
|---|---|
| Cả account một vendor dính limit | Cổng limit theo vendor: mọi agent vendor đó tạm dừng; resume lần lượt khi reset; Supervisor chỉ báo anh khi quá `resumeMaxAttempts` hoặc kẹt quá ngân sách thời gian |
| Daemon / plugin restart | State, hàng đợi, timer resume nằm trên đĩa; đối soát khi khởi động (§7.1) |
| Plugin chết | Fail closed: agent mất tool `slp`, không báo cáo / nhắn được, dừng. Không có ghi nào ngoài router |
| Context Supervisor / Lead đầy | Xoay vòng (§7.5); Peer vẫn chạy |
| Agent chết giữa task | `agent.closed` không có `release` → báo cha logic; worktree + branch giữ; Lead giao task cho Peer mới tiếp từ branch cũ |
| Fix round 3 | Lead bắt buộc đối chiếu tiền đề (§6.5); round 5 (trần Superpowers) → park / hoãn / leo thang |
| Challenge không ai trả lời | Quá `challengeAnswerMinutes` → nhắc Lead; quá gấp đôi → báo Supervisor |
| Anh vắng ở cổng | Việc độc lập chạy tiếp; heartbeat nhắc; không gì được push |
| Vượt ngân sách brief | Supervisor hỏi anh (đổi cost là quyền của anh) |
| Reviewer sửa file | Review vô hiệu; Lead spawn reviewer mới |
| Kiểm bằng chứng fail (verify hoặc hook của repo trong sandbox) | Task không accepted; output gửi về Peer để sửa (tính là một fix round); report kế tiếp tạo commit mới nối lên trên |
| `slp_report` mà worktree không có thay đổi | Từ chối report, báo Peer |
| Có file nhạy cảm (`.env*`, khoá) trong thay đổi | Không đưa vào commit; báo Peer và Lead |
| `sandbox.runner` không chạy được (thiếu Codex CLI, profile đổi tên) | Fail closed: không chạy verify ngoài sandbox; task không accepted; báo Supervisor |
| Lệnh verify cần mạng | Verify chạy với mạng bị chặn; dependency phải được Peer cài trước trong worktree (Claude sandbox cho `claudeAllowedDomains`). Verify fail vì mạng → báo Lead sửa lệnh verify trong plan |
| Merge main sau feature khác ship có conflict | Plugin báo Lead; Lead giao task resolve cho Peer-impl; nếu chạm contract của feature đã ship → challenge lên Supervisor |

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

Không đặt mục tiêu tuyệt đối trước: baseline tính theo session, không theo feature; 1–2 feature đầu dùng để hiệu chỉnh. Kỳ vọng định tính: prompt của anh ≈ 3 cổng + leo thang thật; hỏi tiến độ ≈ 0; limit không cần anh can thiệp.

### 10.2 Rà sau khoảng 3 feature

Supervisor đề xuất, anh quyết:
- Cơ chế không làm đổi kết quả lần nào → đề xuất tắt cờ (ví dụ: `evidenceCheck` chưa bắt được claim sai nào; reviewer khác vendor không đổi kết luận nào mà tốn token).
- Heuristic: Peer leo thang cùng loại vấn đề nhiều lần → chỉ dẫn của Lead lỗi; Lead phải đọc transcript mới hiểu Peer → giao thức báo cáo thiếu; Supervisor liên tục cứu quyết định của Lead → ranh giới vai sai; xoay vòng Supervisor nhiều lần/ngày hoặc leo thang bị trễ → cân nhắc tách phạm vi Supervisor.

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

**Còn mở, kiểm lúc triển khai:** dạng thật của một turn dính limit (S2); cách đóng localhost cho Codex chạy qua Paseo (S3); `claudeAllowedDomains` có đủ để Peer cài dependency không; tên profile `:workspace` của `codex sandbox` khi Codex CLI lên bản mới.

### 11.2 Unit test plugin

Ma trận quyền §5.2 (mỗi ô được/không được); cạnh router §7.3; suy ra trạng thái §5.3 (supersede → stale, kể cả qua T#; confirms; park/unpark); kiểm quote §7.6; cổng limit theo vendor; đối soát sau restart; trần writer; reviewer sửa file → review vô hiệu; commit thay Peer (không thay đổi → từ chối; file nhạy cảm bị loại; hook husky trong worktree **không chạy** khi plugin commit/merge); verify chạy qua `sandbox.runner` (runner hỏng → fail closed, không chạy ngoài sandbox); `Write`/`Edit` ngoài worktree → bị từ chối; model ngoài `models.allowed` → `slp_spawn` bị từ chối.

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
- `paseoTools.disabledTools` / `enabled: false` theo provider ID — không phải ranh giới bảo mật nếu agent có shell.
- Plugin server: event `agent.created/closed/turn_started/turn_ended/permission_requested/permission_resolved/archived`, `workspace.created/archived` (live, best-effort, không replay, timeout 30 s); `before agent.create` sửa systemPrompt / mcpServers / toolPolicy / providerOptions (không đổi cwd); `before agent.session_open` chỉ env; `respondToPermission`; `timeline.refetch`; `agent.send`; settings document bền.
- Provider tuỳ chỉnh (`extends`) hiện đúng ID trong hook; plugin set được `providerOptions.sandbox` cho Claude và `sandbox_mode`/`sandbox_workspace_write` cho Codex (Codex dùng lại policy đã resolve nếu cùng loại — `codex-app-server-agent.ts:4256-4263`).
- Máy anh: Paseo app tự cập nhật lên 0.12.0 ngày 2026-10-21; daemon do app quản lý; `pluginsEnabled` chưa bật (đã bật tạm cho spike rồi trả lại); `injectIntoAgents: true`; Codex CLI 0.163.0 với `sandbox_mode = "danger-full-access"` toàn cục trong `~/.codex/config.toml` (mode `auto` của Paseo vẫn áp workspace-write).

Còn giả định: xem cuối §11.1.

## 13. Rủi ro còn mở

- **Localhost mở với Codex chạy qua Paseo (Peer-review):** về lý thuyết reviewer có thể nói chuyện thẳng với WebSocket của daemon (đọc được file credential trong `~/.paseo`) để lách router. Giảm bằng: reviewer chỉ chạy trong worktree dùng-một-lần, bị kiểm không sửa file tracked, không có tool nhắn tin; tin lạ tới agent khác hiện là `agent_message` có `sender` hoặc bị ghi là `human_message` (có thể ghi nhầm nguồn). Nếu đo thấy cần, đổi reviewer sang Claude-sandbox và chấp nhận cùng vendor với implementer, hoặc đặt password cho daemon.
- **`Write`/`Edit` của Claude không đi qua sandbox hệ điều hành:** chặn ghi ngoài worktree dựa vào plugin đọc `input.file_path`. Đường dẫn qua symlink trong worktree trỏ ra ngoài là ca cần test lúc triển khai (plugin resolve realpath trước khi so).
- **Chi phí topology:** điều phối nhiều agent tốn gấp nhiều lần turn/token so với một phiên đơn. Đo ở §10; nếu không bù được bằng toil giảm, thu hẹp (tắt Supervisor duyệt plan, tắt reviewer khác vendor…).
- **Limit tập trung:** mặc định 3/4 vai dùng Claude (Supervisor, Lead, Peer-impl) → limit Claude đánh vào cả ba cùng lúc. Cổng limit theo vendor giữ cho reviewer Codex chạy tiếp; cân nhắc đổi Lead sang Codex nếu đo thấy kẹt.
- **Phụ thuộc Codex CLI cho sandbox runner:** verify chạy qua `codex sandbox`; Codex CLI đổi cú pháp (như việc bắt buộc `--permission-profile` ở 0.163) là verify fail closed cho tới khi sửa config.
- **Supervisor phán đoán sai thay anh:** Supervisor duyệt plan và phân loại leo thang. Giảm bằng: cổng brief/spec/ship luôn là anh; mọi ruling và quyết định của Supervisor nằm trong gói ship.
- **Sự kiện tiền đề sai hiếm:** pilot có thể không gặp challenge mức spec nào; khi đó chỉ đo được phần vận hành.
- **Paseo thay đổi nhanh** (0.x): hook, tool, format có thể đổi; plugin khai `requirements.paseo` chặt.
- **Bật plugin là chạy code không sandbox trên daemon** — cần anh đồng ý riêng ở bước triển khai.
