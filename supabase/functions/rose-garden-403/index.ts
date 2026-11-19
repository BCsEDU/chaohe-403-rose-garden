import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TABLE_NAME = "rose_garden_groups_403";
const MAX_GROUPS = 15;
const MAX_SEAT = 29;
const GRID_LEN = 100;
const DEFAULT_GRID = ".".repeat(GRID_LEN);
const GRID_RE = /^[.GRBW]{100}$/;
const MAX_PROCESSED_OPS = 40;

const TARGETS = {
  G: 25,
  R: 50,
  B: 5,
  W: 20,
} as const;

interface RoseGroupRow {
  group_key: string;
  group_no: number;
  seats: number[];
  grid: string;
  title: string;
  note: string;
  attempts: number;
  wrong_attempts: number;
  misconceptions: string[];
  processed_ops?: string[];
  is_completed: boolean;
  completed_at: string | null;
  is_featured: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function getSecretKey(): string {
  const secretJson = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretJson) {
    try {
      const parsed = JSON.parse(secretJson);
      if (parsed?.default) return String(parsed.default);
    } catch {
      // fallback
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}

function getAllowedClientKeys(): string[] {
  const keys: string[] = [];
  const pubJson = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (pubJson) {
    try {
      const parsed = JSON.parse(pubJson);
      Object.values(parsed).forEach((v) => {
        if (typeof v === "string" && v) keys.push(v);
      });
    } catch {
      // ignore
    }
  }
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (anon) keys.push(anon);
  keys.push("sb_publishable_4_8Lj3idSkZ0z74V4AIpRA_qqyEicMd");
  return keys;
}

function isAuthorizedClient(req: Request): boolean {
  const allowed = getAllowedClientKeys();
  if (allowed.length === 0) return true;
  const apiKey = req.headers.get("apikey") ?? "";
  const authHeader = req.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  return allowed.includes(apiKey) || (bearer !== "" && allowed.includes(bearer));
}

function normalizeSeats(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const nums = raw.map((x) => Number(x));
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > MAX_SEAT)) return null;
  const unique = Array.from(new Set(nums)).sort((a, b) => a - b);
  if (unique.length < 1 || unique.length > 3) return null;
  return unique;
}

function countGrid(grid: string) {
  let G = 0;
  let R = 0;
  let B = 0;
  let W = 0;
  let empty = 0;
  for (let i = 0; i < grid.length; i++) {
    const ch = grid[i];
    if (ch === "G") G++;
    else if (ch === "R") R++;
    else if (ch === "B") B++;
    else if (ch === "W") W++;
    else empty++;
  }
  return { G, R, B, W, empty, painted: G + R + B + W };
}

function evaluateGrid(grid: string, attemptsAfter = 1) {
  const counts = countGrid(grid);
  const grayOk = counts.G === TARGETS.G;
  const redOk = counts.R === TARGETS.R;
  const blueOk = counts.B === TARGETS.B;
  // 剩下 0.20 塊白玫瑰：若灰、紅、藍皆正確，其餘 20 格無論留白或顯式塗白玫瑰都符合題意
  const baseMatch = grayOk && redOk && blueOk;
  const whiteOk = baseMatch ? counts.W + counts.empty === TARGETS.W : counts.W === TARGETS.W;
  const passed = baseMatch && counts.W + counts.empty === TARGETS.W;

  const misconceptions: string[] = [];
  if (!grayOk) misconceptions.push("gray_not_25");
  if (!redOk) {
    if (counts.R === 5) misconceptions.push("red_5_like_005");
    else misconceptions.push("red_not_50");
  }
  if (!blueOk) {
    if (counts.B === 50) misconceptions.push("blue_50_like_05");
    else misconceptions.push("blue_not_5");
  }
  if (counts.W > TARGETS.W) misconceptions.push("white_exceeds_20");
  else if (!baseMatch && counts.W > 0 && counts.W !== TARGETS.W) misconceptions.push("white_not_20");

  let hint = "";
  if (passed) {
    hint = "🎉 太棒了！0.25 灰玫瑰、0.5 紅玫瑰、0.05 藍玫瑰、0.20 白玫瑰全部完美符合！";
  } else if (counts.painted === 0) {
    hint = "先選一種玫瑰顏色，在百格紙上點選或拖曳上色喔！";
  } else if (counts.R === 5) {
    hint = "💡 紅玫瑰是「0.5 塊」，不是「0.05 塊」喔！想一想：1 條 10 格是 0.1 塊，0.5 塊要塗幾條呢？";
  } else if (counts.B === 50) {
    hint = "💡 藍玫瑰是「0.05 塊」，不是「0.5 塊」喔！0.05 只有幾個 0.01（小格）呢？";
  } else if (counts.W > TARGETS.W) {
    hint = "💡 白玫瑰是「剩下的 0.20 塊」，現在塗超過囉！先檢查灰、紅、藍各塗了幾格吧。";
  } else {
    const wrongNames: string[] = [];
    if (!grayOk) wrongNames.push("灰玫瑰（0.25 塊）");
    if (!redOk) wrongNames.push("紅玫瑰（0.5 塊）");
    if (!blueOk) wrongNames.push("藍玫瑰（0.05 塊）");
    if (wrongNames.length > 0) {
      hint =
        attemptsAfter >= 2
          ? `🔍 提示：1 大格代表 1 塊，共有 100 小格，每小格是 0.01 塊、1 整條 10 格是 0.1 塊！請再檢查：${wrongNames.join("、")}。`
          : `🔍 還差一點點！請再點數確認：${wrongNames.join("、")} 的格數是不是剛好喔！`;
    } else {
      hint = "🔍 再檢查一下各顏色合起來有沒有剛好是整塊花圃（100 格）喔！";
    }
  }

  return {
    passed,
    counts,
    checks: {
      gray: { ok: grayOk, count: counts.G },
      red: { ok: redOk, count: counts.R },
      blue: { ok: blueOk, count: counts.B },
      white: { ok: whiteOk, count: counts.W, effective: passed ? TARGETS.W : counts.W },
    },
    misconceptions,
    hint,
  };
}

function summarizeGroup(row: RoseGroupRow) {
  const c = countGrid(row.grid);
  return {
    group_key: row.group_key,
    group_no: row.group_no,
    seats: row.seats,
    title: row.title,
    is_completed: row.is_completed,
    is_featured: row.is_featured,
    painted_count: c.painted,
    updated_at: row.updated_at,
  };
}

async function verifyTeacherPw(supabaseAdmin: SupabaseClient, pw: string): Promise<boolean> {
  if (!pw) return false;
  const { data, error } = await supabaseAdmin
    .from("teacher_config")
    .select("pw")
    .eq("pw", pw)
    .maybeSingle();
  return !error && Boolean(data);
}

function normalizeOpId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, 64);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!isAuthorizedClient(req)) {
    return jsonResponse({ error: "Invalid API key" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const secretKey = getSecretKey();
  if (!supabaseUrl || !secretKey) {
    return jsonResponse({ error: "Server configuration missing" }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const body = await req.json();
    const action = String(body?.action ?? "");

    // --- 1. 登入畫面：取得目前線上組別摘要與座號佔用狀況 ---
    if (action === "lobby") {
      const { data: rows, error } = await supabaseAdmin
        .from(TABLE_NAME)
        .select("*")
        .eq("is_active", true)
        .order("group_no", { ascending: true });

      if (error) return jsonResponse({ error: error.message }, 500);

      const groups = (rows ?? []).map((r) => summarizeGroup(r as RoseGroupRow));
      return jsonResponse({
        groups,
        max_groups: MAX_GROUPS,
        seat_count: MAX_SEAT,
      });
    }

    // --- 2. 組隊登入 / 還原組別 ---
    if (action === "join") {
      const seats = normalizeSeats(body?.seats);
      if (!seats) {
        return jsonResponse({ error: "請選擇 1～3 位有效座號（1～29 號）" }, 400);
      }
      const forceReassign = Boolean(body?.force_reassign);
      const groupKey = seats.join("-");

      const { data: activeRows, error: listErr } = await supabaseAdmin
        .from(TABLE_NAME)
        .select("*")
        .eq("is_active", true)
        .order("group_no", { ascending: true });

      if (listErr) return jsonResponse({ error: listErr.message }, 500);
      const activeList = (activeRows ?? []) as RoseGroupRow[];

      const exactExisting = activeList.find((r) => r.group_key === groupKey);
      if (exactExisting) {
        return jsonResponse({
          status: "joined",
          restored: true,
          group: exactExisting,
        });
      }

      // 檢查是否有組員座號已在其他線上組別中
      const conflicts = activeList.filter((r) => r.seats.some((s) => seats.includes(s)));
      if (conflicts.length > 0 && !forceReassign) {
        return jsonResponse({
          status: "conflict",
          conflicts: conflicts.map((r) => ({
            ...summarizeGroup(r),
            overlapping_seats: r.seats.filter((s) => seats.includes(s)),
          })),
        });
      }

      // 若確認改組，將重疊座號從舊組移出（若舊組因此沒人則停用；若剩餘人數 >= 1 則搬遷保留其畫作）
      if (conflicts.length > 0 && forceReassign) {
        for (const oldGroup of conflicts) {
          const remaining = oldGroup.seats.filter((s) => !seats.includes(s)).sort((a, b) => a - b);
          const { error: deactErr } = await supabaseAdmin
            .from(TABLE_NAME)
            .update({ is_active: false })
            .eq("group_key", oldGroup.group_key);
          if (deactErr) return jsonResponse({ error: deactErr.message }, 500);

          if (remaining.length > 0) {
            const migratedKey = remaining.join("-");
            const { error: migErr } = await supabaseAdmin
              .from(TABLE_NAME)
              .upsert(
                {
                  group_key: migratedKey,
                  group_no: oldGroup.group_no,
                  seats: remaining,
                  grid: oldGroup.grid,
                  title: oldGroup.title,
                  note: oldGroup.note,
                  attempts: oldGroup.attempts,
                  wrong_attempts: oldGroup.wrong_attempts,
                  misconceptions: oldGroup.misconceptions,
                  processed_ops: Array.isArray(oldGroup.processed_ops) ? oldGroup.processed_ops : [],
                  is_completed: oldGroup.is_completed,
                  completed_at: oldGroup.completed_at,
                  is_featured: oldGroup.is_featured,
                  is_active: true,
                },
                { onConflict: "group_key" }
              );
            if (migErr) return jsonResponse({ error: migErr.message }, 500);
          }
        }
      }

      // 重新讀取目前佔用的 group_no（1..15），遇併發搶號（23505）自動重試
      let created: RoseGroupRow | null = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const { data: refreshedRows, error: refErr } = await supabaseAdmin
          .from(TABLE_NAME)
          .select("group_key, group_no")
          .eq("is_active", true);

        if (refErr) return jsonResponse({ error: refErr.message }, 500);

        // 若同一秒內已有相同 group_key 搶先建立成功，直接還原
        const concurrentSame = (refreshedRows ?? []).find((r) => r.group_key === groupKey);
        if (concurrentSame) {
          const { data: fullRow, error: fErr } = await supabaseAdmin
            .from(TABLE_NAME)
            .select("*")
            .eq("group_key", groupKey)
            .eq("is_active", true)
            .maybeSingle();
          if (fErr) return jsonResponse({ error: fErr.message }, 500);
          if (fullRow) {
            return jsonResponse({
              status: "joined",
              restored: true,
              group: fullRow,
            });
          }
        }

        const usedNos = new Set((refreshedRows ?? []).map((r) => Number(r.group_no)));
        let assignedNo = 0;
        for (let n = 1; n <= MAX_GROUPS; n++) {
          if (!usedNos.has(n)) {
            assignedNo = n;
            break;
          }
        }
        if (assignedNo === 0) {
          return jsonResponse(
            { error: "目前已達 15 組同時登入上限，請點選原組別繼續，或請老師從後台清空未使用的組別。" },
            409
          );
        }

        const { data: upData, error: upErr } = await supabaseAdmin
          .from(TABLE_NAME)
          .upsert(
            {
              group_key: groupKey,
              group_no: assignedNo,
              seats,
              grid: DEFAULT_GRID,
              title: "",
              note: "",
              attempts: 0,
              wrong_attempts: 0,
              misconceptions: [],
              processed_ops: [],
              is_completed: false,
              completed_at: null,
              is_featured: false,
              is_active: true,
            },
            { onConflict: "group_key" }
          )
          .select("*")
          .single();

        if (!upErr && upData) {
          created = upData as RoseGroupRow;
          break;
        }

        const msg = String(upErr?.message || "");
        if (upErr?.code === "23505" || msg.includes("duplicate key") || msg.includes("idx_rose_garden_groups_403_active_no")) {
          await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 70)));
          continue;
        }
        return jsonResponse({ error: msg || "Failed to join group" }, 500);
      }

      if (!created) {
        return jsonResponse(
          { error: "同時登入人數較多，請再點一次「開始種玫瑰花圃」即可進入！" },
          409
        );
      }

      return jsonResponse({
        status: "joined",
        restored: false,
        group: created,
      });
    }

    // --- 3. 讀取指定組別目前雲端狀態 ---
    if (action === "load") {
      const groupKey = String(body?.group_key ?? "").trim();
      if (!groupKey) return jsonResponse({ error: "Missing group_key" }, 400);

      const { data, error } = await supabaseAdmin
        .from(TABLE_NAME)
        .select("*")
        .eq("group_key", groupKey)
        .eq("is_active", true)
        .maybeSingle();

      if (error) return jsonResponse({ error: error.message }, 500);
      if (!data) return jsonResponse({ found: false });
      return jsonResponse({ found: true, group: data });
    }

    // --- 4. 自動同步畫布進度 ---
    if (action === "save") {
      const groupKey = String(body?.group_key ?? "").trim();
      const grid = String(body?.grid ?? "");
      if (!groupKey || !GRID_RE.test(grid)) {
        return jsonResponse({ error: "Invalid group_key or grid" }, 400);
      }

      const { data: existing, error: findErr } = await supabaseAdmin
        .from(TABLE_NAME)
        .select("*")
        .eq("group_key", groupKey)
        .eq("is_active", true)
        .maybeSingle();

      if (findErr) return jsonResponse({ error: findErr.message }, 500);
      if (!existing) return jsonResponse({ error: "group_not_active" }, 404);

      const title = body?.title !== undefined ? String(body.title).trim().slice(0, 30) : existing.title;
      const note = body?.note !== undefined ? String(body.note).trim().slice(0, 120) : existing.note;

      const evalRes = evaluateGrid(grid, existing.attempts);
      const keepCompleted = Boolean(existing.is_completed) && evalRes.passed;

      const { data: saved, error: updErr } = await supabaseAdmin
        .from(TABLE_NAME)
        .update({
          grid,
          title,
          note,
          is_completed: keepCompleted,
          completed_at: keepCompleted ? existing.completed_at : null,
        })
        .eq("group_key", groupKey)
        .eq("is_active", true)
        .select("*")
        .single();

      if (updErr) return jsonResponse({ error: updErr.message }, 500);
      return jsonResponse({ status: "saved", group: saved });
    }

    // --- 5. 檢查並送出（支援 op_id 冪等防重送） ---
    if (action === "check") {
      const groupKey = String(body?.group_key ?? "").trim();
      const grid = String(body?.grid ?? "");
      const opId = normalizeOpId(body?.op_id);
      if (!groupKey || !GRID_RE.test(grid)) {
        return jsonResponse({ error: "Invalid group_key or grid" }, 400);
      }

      const { data: existing, error: findErr } = await supabaseAdmin
        .from(TABLE_NAME)
        .select("*")
        .eq("group_key", groupKey)
        .eq("is_active", true)
        .maybeSingle();

      if (findErr) return jsonResponse({ error: findErr.message }, 500);
      if (!existing) return jsonResponse({ error: "group_not_active" }, 404);

      const prevOps = Array.isArray(existing.processed_ops) ? existing.processed_ops.map(String) : [];
      if (opId && prevOps.includes(opId)) {
        const dedupEval = evaluateGrid(existing.grid, Number(existing.attempts || 1));
        return jsonResponse({
          status: "checked",
          deduplicated: true,
          passed: dedupEval.passed,
          counts: dedupEval.counts,
          checks: dedupEval.checks,
          misconception_codes: dedupEval.misconceptions,
          hint: dedupEval.hint,
          group: existing,
        });
      }

      const title = body?.title !== undefined ? String(body.title).trim().slice(0, 30) : existing.title;
      const note = body?.note !== undefined ? String(body.note).trim().slice(0, 120) : existing.note;

      const nextAttempts = Number(existing.attempts || 0) + 1;
      const evalRes = evaluateGrid(grid, nextAttempts);
      const nextWrong = Number(existing.wrong_attempts || 0) + (evalRes.passed ? 0 : 1);

      const prevMis = Array.isArray(existing.misconceptions) ? existing.misconceptions.map(String) : [];
      const mergedMis = Array.from(new Set([...prevMis, ...evalRes.misconceptions]));
      const nextOps = opId ? [...prevOps, opId].slice(-MAX_PROCESSED_OPS) : prevOps;

      const { data: saved, error: updErr } = await supabaseAdmin
        .from(TABLE_NAME)
        .update({
          grid,
          title,
          note,
          attempts: nextAttempts,
          wrong_attempts: nextWrong,
          misconceptions: mergedMis,
          processed_ops: nextOps,
          is_completed: evalRes.passed,
          completed_at: evalRes.passed ? (existing.completed_at ?? new Date().toISOString()) : null,
        })
        .eq("group_key", groupKey)
        .eq("is_active", true)
        .select("*")
        .single();

      if (updErr) return jsonResponse({ error: updErr.message }, 500);

      return jsonResponse({
        status: "checked",
        passed: evalRes.passed,
        counts: evalRes.counts,
        checks: evalRes.checks,
        misconception_codes: evalRes.misconceptions,
        hint: evalRes.hint,
        group: saved,
      });
    }

    // --- 5b. 離線恢復連線批次補傳（原子化重播離線檢查＋最新畫布，具備 op_id 冪等防重算） ---
    if (action === "sync_offline") {
      const groupKey = String(body?.group_key ?? "").trim();
      const finalGrid = String(body?.grid ?? "");
      if (!groupKey || !GRID_RE.test(finalGrid)) {
        return jsonResponse({ error: "Invalid group_key or grid" }, 400);
      }

      const { data: existing, error: findErr } = await supabaseAdmin
        .from(TABLE_NAME)
        .select("*")
        .eq("group_key", groupKey)
        .eq("is_active", true)
        .maybeSingle();

      if (findErr) return jsonResponse({ error: findErr.message }, 500);
      if (!existing) return jsonResponse({ error: "group_not_active" }, 404);

      const rawChecks = Array.isArray(body?.checks) ? body.checks.slice(0, 50) : [];
      let attempts = Number(existing.attempts || 0);
      let wrongAttempts = Number(existing.wrong_attempts || 0);
      const misSet = new Set<string>(
        Array.isArray(existing.misconceptions) ? existing.misconceptions.map(String) : []
      );
      const ops: string[] = Array.isArray(existing.processed_ops) ? existing.processed_ops.map(String) : [];
      const opsSet = new Set<string>(ops);

      let isCompleted = Boolean(existing.is_completed);
      let completedAt: string | null = existing.completed_at;
      let title = String(existing.title || "");

      for (const item of rawChecks) {
        const cOpId = normalizeOpId(item?.op_id);
        const cGrid = String(item?.grid ?? "");
        if (!cOpId || !GRID_RE.test(cGrid) || opsSet.has(cOpId)) {
          continue;
        }
        ops.push(cOpId);
        opsSet.add(cOpId);

        attempts += 1;
        const ev = evaluateGrid(cGrid, attempts);
        if (!ev.passed) {
          wrongAttempts += 1;
        }
        ev.misconceptions.forEach((m) => misSet.add(m));
        isCompleted = ev.passed;
        completedAt = ev.passed ? (completedAt ?? new Date().toISOString()) : null;
        if (item?.title !== undefined) {
          title = String(item.title).trim().slice(0, 30);
        }
      }

      const finalTitle = body?.title !== undefined ? String(body.title).trim().slice(0, 30) : title;
      const finalNote = body?.note !== undefined ? String(body.note).trim().slice(0, 120) : existing.note;

      const finalEval = evaluateGrid(finalGrid, attempts);
      const keepCompleted = Boolean(isCompleted) && finalEval.passed;

      const { data: saved, error: updErr } = await supabaseAdmin
        .from(TABLE_NAME)
        .update({
          grid: finalGrid,
          title: finalTitle,
          note: finalNote,
          attempts,
          wrong_attempts: wrongAttempts,
          misconceptions: Array.from(misSet),
          processed_ops: ops.slice(-MAX_PROCESSED_OPS),
          is_completed: keepCompleted,
          completed_at: keepCompleted ? (completedAt ?? new Date().toISOString()) : null,
        })
        .eq("group_key", groupKey)
        .eq("is_active", true)
        .select("*")
        .single();

      if (updErr) return jsonResponse({ error: updErr.message }, 500);
      return jsonResponse({ status: "synced", group: saved });
    }

    // --- 6. 教師後台端點（密碼驗證） ---
    if (
      action === "teacher_list" ||
      action === "teacher_toggle_featured" ||
      action === "teacher_reset"
    ) {
      const pw = String(body?.pw ?? "");
      const ok = await verifyTeacherPw(supabaseAdmin, pw);
      if (!ok) return jsonResponse({ error: "unauthorized" }, 401);

      if (action === "teacher_toggle_featured") {
        const groupKey = String(body?.group_key ?? "").trim();
        const isFeatured = Boolean(body?.is_featured);
        if (!groupKey) return jsonResponse({ error: "Missing group_key" }, 400);

        const { data: updated, error: fErr } = await supabaseAdmin
          .from(TABLE_NAME)
          .update({ is_featured: isFeatured })
          .eq("group_key", groupKey)
          .eq("is_active", true)
          .select("*")
          .maybeSingle();

        if (fErr) return jsonResponse({ error: fErr.message }, 500);
        return jsonResponse({ status: "ok", group: updated });
      }

      if (action === "teacher_reset") {
        const groupKey = body?.group_key ? String(body.group_key).trim() : null;
        if (!groupKey || groupKey === "ALL") {
          const { error: rErr } = await supabaseAdmin
            .from(TABLE_NAME)
            .update({ is_active: false })
            .eq("is_active", true);
          if (rErr) return jsonResponse({ error: rErr.message }, 500);
          return jsonResponse({ status: "reset_all" });
        } else {
          const { error: rErr } = await supabaseAdmin
            .from(TABLE_NAME)
            .update({ is_active: false })
            .eq("group_key", groupKey);
          if (rErr) return jsonResponse({ error: rErr.message }, 500);
          return jsonResponse({ status: "reset_group", group_key: groupKey });
        }
      }

      // teacher_list
      const { data: rows, error: lErr } = await supabaseAdmin
        .from(TABLE_NAME)
        .select("*")
        .eq("is_active", true)
        .order("group_no", { ascending: true });

      if (lErr) {
        const msg = String(lErr.message || "");
        if (lErr.code === "PGRST205" || lErr.code === "42P01" || msg.includes(TABLE_NAME)) {
          return jsonResponse({
            groups: [],
            table_missing: true,
            max_groups: MAX_GROUPS,
            seat_count: MAX_SEAT,
          });
        }
        return jsonResponse({ error: msg }, 500);
      }

      return jsonResponse({
        groups: rows ?? [],
        table_missing: false,
        max_groups: MAX_GROUPS,
        seat_count: MAX_SEAT,
      });
    }

    return jsonResponse({ error: "Unknown action" }, 400);
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Bad request" }, 400);
  }
});
