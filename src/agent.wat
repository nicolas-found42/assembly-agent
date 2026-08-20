;; ═══════════════════════════════════════════════════════════════════════
;;  ASM::AGENT — hand-written WebAssembly Text engine
;;  ─────────────────────────────────────────────────────────────────────
;;  No imports. All I/O flows through linear memory + exports.
;;  JS copies SSE bytes / TLV blobs into the scratch region, then calls
;;  exports. See the MEMORY inspector tab for the live map.
;;
;;  MEMORY MAP
;;  ┌──────────────┬─────────────┬────────────────────────────────────┐
;;  │ 0x00000-0x0FFF │ Control    │ i32 state slots (see below)       │
;;  │ 0x01000-0x4FFF │ SSE rem    │ line-remainder buffer (16 KiB)    │
;;  │ 0x05000-0x05FFF │ fold buf  │ query fold scratch (filters)      │
;;  │ 0x05FF0        │ cursor     │ SSE drop-line flag                │
;;  │ 0x06000-0x607F │ tool meta  │ tcid[64] + name[64] — tc slot 0   │
;;  │ 0x06800-0x06FFF │ tc table  │ 8 tool call slots × 256B          │
;;  │ 0x08000-0x1FFFF │ History   │ 96 KiB bump arena                 │
;;  │ 0x20000-0x30FFF │ Models    │ count + 512×128B records          │
;;  │ 0x31000-0x3FFFF │ Pool      │ 60 KiB string bump                │
;;  │ 0x40000-0x42FFF │ Index     │ 5 sort tables + filtered (0x800)  │
;;  │ 0x50000-0x6FFFF │ Render    │ 128 KiB pending markdown          │
;;  │ 0x70000-0x70FFF │ Consts    │ needle strings (data seg)         │
;;  │ 0x80000-0x8FFFF │ Scratch   │ 64 KiB JS staging area            │
;;  │ 0x90000+       │ Heap       │ bump allocator, grows to 16 MiB   │
;;  └──────────────┴─────────────┴────────────────────────────────────┘
;;
;;  CONTROL SLOTS (i32)
;;    0x00 MAGIC 0x41534D31 ("ASM1")   0x04 state 0=idle 1=stream 2=done 3=err
;;    0x08 err_code                     0x0C msg_count
;;    0x10 hist_bump   0x14 render_len 0x18 model_count 0x1C pool_bump
;;    0x20 heap_bump   0x24 sse_rem_len
;;    0x28 tool_args_ptr 0x2C tool_args_len
;;    0x30 tcid_len   0x34 tc_name_len
;;    0x38 cur_ptr    0x3C cur_len     (per-turn assistant content accum)
;;    0x40 tokens_in  0x44 tokens_out  0x48 render_overflow
;;    0x4C err_ptr    0x50 err_len
;;    0x54 cur_cap    0x58 ta_cap
;;    0x5C tr_ptr 0x60 tr_len 0x64 tr_cap   (tool result accum)
;;    0x68 active_table 0x6C filtered_count
;;    0x70 tc_count   0x74 tc_overflow   (per-turn tool call table)
;; ═══════════════════════════════════════════════════════════════════════

(module
  (memory (export "memory") 16)

  ;; ── needle constants (data segment, reserved region) ─────────────────
  (data (i32.const 0x70000) "data: ")
  (data (i32.const 0x70010) "[DONE]")
  (data (i32.const 0x70020) "\22delta\22")
  (data (i32.const 0x70030) "\22content\22:\22")
  (data (i32.const 0x70040) "\22tool_calls\22")
  (data (i32.const 0x70050) "\22id\22:\22")
  (data (i32.const 0x70060) "\22name\22:\22")
  (data (i32.const 0x70070) "\22arguments\22:\22")
  (data (i32.const 0x70080) "\22error\22")
  (data (i32.const 0x70090) "\22message\22:\22")

  ;; ── named constants ──────────────────────────────────────────────────
  (global $gMagic    i32 (i32.const 0x41534D31))
  (global $cState    i32 (i32.const 0x04))
  (global $cErrCode  i32 (i32.const 0x08))
  (global $cMsgCnt   i32 (i32.const 0x0C))
  (global $cHistBump i32 (i32.const 0x10))
  (global $cRendLen  i32 (i32.const 0x14))
  (global $cModCnt   i32 (i32.const 0x18))
  (global $cPoolBump i32 (i32.const 0x1C))
  (global $cHeapBump i32 (i32.const 0x20))
  (global $cRemLen   i32 (i32.const 0x24))
  (global $cTaPtr    i32 (i32.const 0x28))
  (global $cTaLen    i32 (i32.const 0x2C))
  (global $cTcidLen  i32 (i32.const 0x30))
  (global $cTcNameLen i32 (i32.const 0x34))
  (global $cCurPtr   i32 (i32.const 0x38))
  (global $cCurLen   i32 (i32.const 0x3C))
  (global $cTokIn    i32 (i32.const 0x40))
  (global $cTokOut   i32 (i32.const 0x44))
  (global $cRendOvf  i32 (i32.const 0x48))
  (global $cErrPtr   i32 (i32.const 0x4C))
  (global $cErrLen   i32 (i32.const 0x50))
  (global $cCurCap   i32 (i32.const 0x54))
  (global $cTaCap    i32 (i32.const 0x58))
  (global $cTrPtr    i32 (i32.const 0x5C))
  (global $cTrLen    i32 (i32.const 0x60))
  (global $cTrCap    i32 (i32.const 0x64))
  (global $cActTbl   i32 (i32.const 0x68))
  (global $cFilCnt   i32 (i32.const 0x6C))
  (global $cTcCount  i32 (i32.const 0x70))
  (global $cTcOvf    i32 (i32.const 0x74))
  (global $gRemBuf   i32 (i32.const 0x1000))
  (global $gFoldBuf  i32 (i32.const 0x5000))
  (global $gDrop     i32 (i32.const 0x5FF0))
  (global $gTcid     i32 (i32.const 0x6000))
  (global $gTcName   i32 (i32.const 0x6040))
  (global $gTcTbl    i32 (i32.const 0x6800))
  (global $gTcTblLen i32 (i32.const 0x800))
  (global $gTcMax    i32 (i32.const 8))
  (global $gHistBase i32 (i32.const 0x8000))
  (global $gHistEnd  i32 (i32.const 0x20000))
  (global $gRecCnt   i32 (i32.const 0x20000))
  (global $gRecBase  i32 (i32.const 0x20010))
  (global $gPoolBase i32 (i32.const 0x31000))
  (global $gPoolEnd  i32 (i32.const 0x40000))
  (global $gTblBase  i32 (i32.const 0x40000))
  (global $gTblFil   i32 (i32.const 0x42800))
  (global $gRendBuf  i32 (i32.const 0x50000))
  (global $gRendCap  i32 (i32.const 0x20000))
  (global $gScratch  i32 (i32.const 0x80000))
  (global $gHeapBase i32 (i32.const 0x90000))

  ;; ══════════════════════════ small helpers ══════════════════════════

  ;; $find — substring search, returns absolute match ptr or -1
  (func $find (param $hay i32) (param $hlen i32) (param $nd i32) (param $nlen i32) (result i32)
    (local $i i32) (local $j i32) (local $ok i32)
    (if (i32.lt_u (local.get $hlen) (local.get $nlen))
      (then (return (i32.const -1))))
    (local.set $i (i32.const 0))
    (loop $scan
      (if (i32.gt_u (local.get $i) (i32.sub (local.get $hlen) (local.get $nlen)))
        (then (return (i32.const -1))))
      (local.set $j (i32.const 0))
      (local.set $ok (i32.const 1))
      (block $mm (loop $m
        (br_if $mm (i32.eqz (local.get $ok)))
        (br_if $mm (i32.ge_u (local.get $j) (local.get $nlen)))
        (if (i32.ne
              (i32.load8_u (i32.add (local.get $hay) (i32.add (local.get $i) (local.get $j))))
              (i32.load8_u (i32.add (local.get $nd) (local.get $j))))
          (then (local.set $ok (i32.const 0))))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $m)
      ))
      (if (local.get $ok)
        (then (return (i32.add (local.get $hay) (local.get $i)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $scan)
    )
    (i32.const -1)
  )

  ;; $scan_quote — position of closing unescaped '"' in [s,end), or end
  (func $scan_quote (param $s i32) (param $end i32) (result i32)
    (local $p i32) (local $b i32)
    (local.set $p (local.get $s))
    (block $done (loop $l
      (br_if $done (i32.ge_u (local.get $p) (local.get $end)))
      (local.set $b (i32.load8_u (local.get $p)))
      (if (i32.eq (local.get $b) (i32.const 92))
        (then (local.set $p (i32.add (local.get $p) (i32.const 2))))
        (else
          (if (i32.eq (local.get $b) (i32.const 34))
            (then (return (local.get $p)))
            (else (local.set $p (i32.add (local.get $p) (i32.const 1)))))))
      (br $l)
    ))
    (local.get $end)
  )

  ;; $hex4 — 4 ASCII hex digits at p → i32
  (func $hex4 (param $p i32) (result i32)
    (local $r i32) (local $i i32) (local $b i32) (local $v i32)
    (local.set $r (i32.const 0))
    (local.set $i (i32.const 0))
    (loop $l
      (if (i32.ge_u (local.get $i) (i32.const 4)) (then (return (local.get $r))))
      (local.set $b (i32.load8_u (i32.add (local.get $p) (local.get $i))))
      (if (i32.ge_s (local.get $b) (i32.const 97))
        (then (local.set $v (i32.sub (local.get $b) (i32.const 87))))
        (else
          (if (i32.ge_s (local.get $b) (i32.const 65))
            (then (local.set $v (i32.sub (local.get $b) (i32.const 55))))
            (else (local.set $v (i32.sub (local.get $b) (i32.const 48)))))))
      (local.set $r (i32.or (i32.shl (local.get $r) (i32.const 4)) (local.get $v)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)
    )
    (i32.const 0)
  )

  ;; $utf8_emit — write codepoint at w, return w + nbytes
  (func $utf8_emit (param $w i32) (param $cp i32) (result i32)
    (if (i32.lt_u (local.get $cp) (i32.const 0x80))
      (then
        (i32.store8 (local.get $w) (local.get $cp))
        (return (i32.add (local.get $w) (i32.const 1)))))
    (if (i32.lt_u (local.get $cp) (i32.const 0x800))
      (then
        (i32.store8 (local.get $w) (i32.or (i32.const 0xC0) (i32.shr_u (local.get $cp) (i32.const 6))))
        (i32.store8 (i32.add (local.get $w) (i32.const 1))
          (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))))
        (return (i32.add (local.get $w) (i32.const 2)))))
    (if (i32.lt_u (local.get $cp) (i32.const 0x10000))
      (then
        (i32.store8 (local.get $w) (i32.or (i32.const 0xE0) (i32.shr_u (local.get $cp) (i32.const 12))))
        (i32.store8 (i32.add (local.get $w) (i32.const 1))
          (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 6)) (i32.const 0x3F))))
        (i32.store8 (i32.add (local.get $w) (i32.const 2))
          (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))))
        (return (i32.add (local.get $w) (i32.const 3)))))
    (i32.store8 (local.get $w) (i32.or (i32.const 0xF0) (i32.shr_u (local.get $cp) (i32.const 18))))
    (i32.store8 (i32.add (local.get $w) (i32.const 1))
      (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 12)) (i32.const 0x3F))))
    (i32.store8 (i32.add (local.get $w) (i32.const 2))
      (i32.or (i32.const 0x80) (i32.and (i32.shr_u (local.get $cp) (i32.const 6)) (i32.const 0x3F))))
    (i32.store8 (i32.add (local.get $w) (i32.const 3))
      (i32.or (i32.const 0x80) (i32.and (local.get $cp) (i32.const 0x3F))))
    (i32.add (local.get $w) (i32.const 4))
  )

  ;; $decode_inplace — decode JSON string body [s,e) escaping to raw UTF-8
  ;; in place (output never outgrows input). Returns decoded length.
  (func $decode_inplace (param $s i32) (param $e i32) (result i32)
    (local $pos i32) (local $w i32) (local $b i32) (local $c i32)
    (local $adv i32) (local $cp i32) (local $lo i32) (local $x i32)
    (local.set $pos (local.get $s))
    (local.set $w (local.get $s))
    (block $fin (loop $dl
      (br_if $fin (i32.ge_u (local.get $pos) (local.get $e)))
      (local.set $b (i32.load8_u (local.get $pos)))
      (if (i32.ne (local.get $b) (i32.const 92))
        (then ;; plain byte
          (i32.store8 (local.get $w) (local.get $b))
          (local.set $w (i32.add (local.get $w) (i32.const 1)))
          (local.set $pos (i32.add (local.get $pos) (i32.const 1)))
          (br $dl)))
      ;; escape: need at least 2 bytes and room for the escape body
      ;; A complete 2-byte escape may sit flush against $e (pos+2 == e): providers
      ;; chunk tool-call arguments mid-string, so `{\"` arrives as its own
      ;; fragment. Only pos+2 > e is a genuine trailing lone backslash.
      (if (i32.gt_u (i32.add (local.get $pos) (i32.const 2)) (local.get $e))
        (then ;; trailing lone backslash (malformed) — stop
          (br $fin)))
    (local.set $c (i32.load8_u (i32.add (local.get $pos) (i32.const 1))))
    (local.set $adv (i32.const 2))
    (if (i32.eq (local.get $c) (i32.const 34))
      (then (i32.store8 (local.get $w) (i32.const 34))
            (local.set $w (i32.add (local.get $w) (i32.const 1)))))
    (if (i32.eq (local.get $c) (i32.const 92))
      (then (i32.store8 (local.get $w) (i32.const 92))
            (local.set $w (i32.add (local.get $w) (i32.const 1)))))
    (if (i32.eq (local.get $c) (i32.const 47))
      (then (i32.store8 (local.get $w) (i32.const 47))
            (local.set $w (i32.add (local.get $w) (i32.const 1)))))
    (if (i32.eq (local.get $c) (i32.const 98))
      (then (i32.store8 (local.get $w) (i32.const 8))
            (local.set $w (i32.add (local.get $w) (i32.const 1)))))
    (if (i32.eq (local.get $c) (i32.const 102))
      (then (i32.store8 (local.get $w) (i32.const 12))
            (local.set $w (i32.add (local.get $w) (i32.const 1)))))
    (if (i32.eq (local.get $c) (i32.const 110))
      (then (i32.store8 (local.get $w) (i32.const 10))
            (local.set $w (i32.add (local.get $w) (i32.const 1)))))
    (if (i32.eq (local.get $c) (i32.const 114))
      (then (i32.store8 (local.get $w) (i32.const 13))
            (local.set $w (i32.add (local.get $w) (i32.const 1)))))
    (if (i32.eq (local.get $c) (i32.const 116))
      (then (i32.store8 (local.get $w) (i32.const 9))
            (local.set $w (i32.add (local.get $w) (i32.const 1)))))
    (if (i32.eq (local.get $c) (i32.const 117))
      (then
        (if (i32.le_u (i32.add (local.get $pos) (i32.const 6)) (local.get $e))
          (then
            (local.set $cp (call $hex4 (i32.add (local.get $pos) (i32.const 2))))
            (local.set $adv (i32.const 6))
            (if (i32.and
                  (i32.ge_u (local.get $cp) (i32.const 0xD800))
                  (i32.lt_u (local.get $cp) (i32.const 0xDC00)))
              (then
                (if (i32.and
                      (i32.le_u (i32.add (local.get $pos) (i32.const 12)) (local.get $e))
                      (i32.and
                        (i32.eq (i32.load8_u (i32.add (local.get $pos) (i32.const 6))) (i32.const 92))
                        (i32.eq (i32.load8_u (i32.add (local.get $pos) (i32.const 7))) (i32.const 117))))
                  (then
                    (local.set $lo (call $hex4 (i32.add (local.get $pos) (i32.const 8))))
                    (if (i32.and
                          (i32.ge_u (local.get $lo) (i32.const 0xDC00))
                          (i32.lt_u (local.get $lo) (i32.const 0xE000)))
                      (then
                        (local.set $cp
                          (i32.add
                            (i32.const 0x10000)
                            (i32.add
                              (i32.shl (i32.sub (local.get $cp) (i32.const 0xD800)) (i32.const 10))
                              (i32.sub (local.get $lo) (i32.const 0xDC00)))))
                        (local.set $adv (i32.const 12))))))))
            (if (i32.and
                  (i32.ge_u (local.get $cp) (i32.const 0xD800))
                  (i32.lt_u (local.get $cp) (i32.const 0xE000)))
              (then (local.set $cp (i32.const 0xFFFD))))
            (local.set $w (call $utf8_emit (local.get $w) (local.get $cp))))
          (else (br $fin)))))
    ;; unknown escape: emit the char itself
    (local.set $x (i32.const 1))
    (if (i32.eq (local.get $c) (i32.const 34))  (then (local.set $x (i32.const 0))))
    (if (i32.eq (local.get $c) (i32.const 92))  (then (local.set $x (i32.const 0))))
    (if (i32.eq (local.get $c) (i32.const 47))  (then (local.set $x (i32.const 0))))
    (if (i32.eq (local.get $c) (i32.const 98))  (then (local.set $x (i32.const 0))))
    (if (i32.eq (local.get $c) (i32.const 102)) (then (local.set $x (i32.const 0))))
    (if (i32.eq (local.get $c) (i32.const 110)) (then (local.set $x (i32.const 0))))
    (if (i32.eq (local.get $c) (i32.const 114)) (then (local.set $x (i32.const 0))))
    (if (i32.eq (local.get $c) (i32.const 116)) (then (local.set $x (i32.const 0))))
    (if (i32.eq (local.get $c) (i32.const 117)) (then (local.set $x (i32.const 0))))
    (if (local.get $x)
      (then
        (i32.store8 (local.get $w) (local.get $c))
        (local.set $w (i32.add (local.get $w) (i32.const 1)))))
      (local.set $pos (i32.add (local.get $pos) (local.get $adv)))
      (br $dl)
    ))
    (i32.sub (local.get $w) (local.get $s))
  )

  ;; $render_append — copy n bytes into render buffer (count overflow)
  (func $render_append (param $src i32) (param $n i32)
    (if (i32.le_u (local.get $n) (i32.const 0)) (then (return)))
    (if (i32.gt_u (i32.add (i32.load (global.get $cRendLen)) (local.get $n)) (global.get $gRendCap))
      (then
        (i32.store (global.get $cRendOvf)
          (i32.add (i32.load (global.get $cRendOvf)) (local.get $n))))
      (else
        (memory.copy
          (i32.add (global.get $gRendBuf) (i32.load (global.get $cRendLen)))
          (local.get $src)
          (local.get $n))
        (i32.store (global.get $cRendLen)
          (i32.add (i32.load (global.get $cRendLen)) (local.get $n)))))
  )

  ;; $accum_append — growable heap accumulator (ptr/len/cap are slot ADDRS)
  (func $accum_append (param $ps i32) (param $ls i32) (param $cs i32) (param $src i32) (param $n i32)
    (local $p i32) (local $l i32) (local $c i32) (local $nc i32) (local $np i32) (local $need i32)
    (local.set $p (i32.load (local.get $ps)))
    (local.set $l (i32.load (local.get $ls)))
    (local.set $c (i32.load (local.get $cs)))
    (if (i32.le_u (i32.add (local.get $l) (local.get $n)) (local.get $c))
      (then
        (if (i32.gt_u (local.get $n) (i32.const 0))
          (then (memory.copy (i32.add (local.get $p) (local.get $l)) (local.get $src) (local.get $n))))
        (i32.store (local.get $ls) (i32.add (local.get $l) (local.get $n)))
        (return)))
    (local.set $need
      (i32.and (i32.add (i32.add (local.get $l) (local.get $n)) (i32.const 4095)) (i32.const -8)))
    (local.set $nc
      (select (i32.shl (local.get $c) (i32.const 1)) (local.get $need)
        (i32.gt_u (i32.shl (local.get $c) (i32.const 1)) (local.get $need))))
    (local.set $nc
      (select (local.get $nc) (i32.const 4096) (i32.ge_u (local.get $nc) (i32.const 4096))))
    (local.set $np (call $heap_alloc (local.get $nc)))
    (if (i32.eq (local.get $np) (i32.const 0))
      (then
        (i32.store (global.get $cErrCode) (i32.const 6))
        (return)))
    (if (i32.gt_u (local.get $l) (i32.const 0))
      (then (memory.copy (local.get $np) (local.get $p) (local.get $l))))
    (if (i32.gt_u (local.get $n) (i32.const 0))
      (then (memory.copy (i32.add (local.get $np) (local.get $l)) (local.get $src) (local.get $n))))
    (i32.store (local.get $ps) (local.get $np))
    (i32.store (local.get $ls) (i32.add (local.get $l) (local.get $n)))
    (i32.store (local.get $cs) (local.get $nc))
  )

  ;; ═════════════════════ tool call table (0x6800) ═════════════════════
  ;; 8 slots × 256B: id[64] name[64] argsPtr argsLen argsCap idLen nameLen.
  ;; Slot 0's fields ALIAS the legacy control slots (gTcid/gTcName plus
  ;; cTaPtr/cTaLen/cTaCap/cTcidLen/cTcNameLen) so every existing reader —
  ;; pendingToolCall() in js/bridge.js, end_turn, tool_result_flush,
  ;; test/smoke.mjs — keeps working while slots 1..7 hold the parallel calls.

  (func $tc_slot (param $i i32) (result i32)
    (i32.add (global.get $gTcTbl) (i32.mul (local.get $i) (i32.const 256))))
  (func $tc_id (param $i i32) (result i32)
    (if (i32.eqz (local.get $i)) (then (return (global.get $gTcid))))
    (call $tc_slot (local.get $i)))
  (func $tc_name (param $i i32) (result i32)
    (if (i32.eqz (local.get $i)) (then (return (global.get $gTcName))))
    (i32.add (call $tc_slot (local.get $i)) (i32.const 64)))
  (func $tc_args_ptr (param $i i32) (result i32)
    (if (i32.eqz (local.get $i)) (then (return (global.get $cTaPtr))))
    (i32.add (call $tc_slot (local.get $i)) (i32.const 128)))
  (func $tc_args_len (param $i i32) (result i32)
    (if (i32.eqz (local.get $i)) (then (return (global.get $cTaLen))))
    (i32.add (call $tc_slot (local.get $i)) (i32.const 132)))
  (func $tc_args_cap (param $i i32) (result i32)
    (if (i32.eqz (local.get $i)) (then (return (global.get $cTaCap))))
    (i32.add (call $tc_slot (local.get $i)) (i32.const 136)))
  (func $tc_id_len (param $i i32) (result i32)
    (if (i32.eqz (local.get $i)) (then (return (global.get $cTcidLen))))
    (i32.add (call $tc_slot (local.get $i)) (i32.const 140)))
  (func $tc_name_len (param $i i32) (result i32)
    (if (i32.eqz (local.get $i)) (then (return (global.get $cTcNameLen))))
    (i32.add (call $tc_slot (local.get $i)) (i32.const 144)))

  ;; $tc_open — the slot `"name":"` and `"arguments":"` land on: the last
  ;; `"id":"` opened, or slot 0 before any id arrives (a provider may stream
  ;; arguments first). -1 once the table has overflowed, so calls past the
  ;; 8th are dropped instead of being appended onto the 8th.
  (func $tc_open (result i32)
    (if (i32.gt_u (i32.load (global.get $cTcOvf)) (i32.const 0))
      (then (return (i32.const -1))))
    (if (i32.eqz (i32.load (global.get $cTcCount))) (then (return (i32.const 0))))
    (i32.sub (i32.load (global.get $cTcCount)) (i32.const 1)))

  ;; $tc_reset — clear the table, both counters, and slot 0's aliases
  (func $tc_reset
    (memory.fill (global.get $gTcTbl) (i32.const 0) (global.get $gTcTblLen))
    (i32.store (global.get $cTcCount) (i32.const 0))
    (i32.store (global.get $cTcOvf) (i32.const 0))
    (i32.store (global.get $cTcidLen) (i32.const 0))
    (i32.store (global.get $cTcNameLen) (i32.const 0))
    (i32.store (global.get $cTaPtr) (i32.const 0))
    (i32.store (global.get $cTaLen) (i32.const 0))
    (i32.store (global.get $cTaCap) (i32.const 0)))

  ;; $tc_store — copy a decoded value (clamped to 64B) into a slot field
  (func $tc_store (param $dst i32) (param $lenAddr i32) (param $src i32) (param $dlen i32)
    (local $n i32)
    (local.set $n (select (local.get $dlen) (i32.const 64) (i32.lt_u (local.get $dlen) (i32.const 64))))
    (memory.copy (local.get $dst) (local.get $src) (local.get $n))
    (i32.store (local.get $lenAddr) (local.get $n)))

  ;; $fold — ASCII case-fold one byte
  (func $fold (param $b i32) (result i32)
    (if (i32.and (i32.ge_s (local.get $b) (i32.const 65)) (i32.le_s (local.get $b) (i32.const 90)))
      (then (return (i32.add (local.get $b) (i32.const 32)))))
    (local.get $b)
  )

  ;; $folded_contains — ASCII-folded substring match
  (func $folded_contains (param $sp i32) (param $sl i32) (param $qp i32) (param $ql i32) (result i32)
    (local $i i32) (local $j i32)
    (if (i32.le_u (local.get $ql) (i32.const 0)) (then (return (i32.const 1))))
    (if (i32.lt_u (local.get $sl) (local.get $ql)) (then (return (i32.const 0))))
    (local.set $i (i32.const 0))
    (loop $outer
      (local.set $j (i32.const 0))
      (block $mm (loop $m
        (br_if $mm (i32.ge_u (local.get $j) (local.get $ql)))
        (if (i32.ne
              (call $fold (i32.load8_u (i32.add (local.get $sp) (i32.add (local.get $i) (local.get $j)))))
              (i32.load8_u (i32.add (local.get $qp) (local.get $j))))
          (then (br $mm)))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $m)
      ))
      (if (i32.ge_u (local.get $j) (local.get $ql)) (then (return (i32.const 1))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $outer (i32.le_u (local.get $i) (i32.sub (local.get $sl) (local.get $ql))))
    )
    (i32.const 0)
  )

  ;; ══════════════════════════ model sorting ══════════════════════════

  ;; $key_less — strict "a sorts before b" per metric (no desc here)
  (func $key_less (param $a i32) (param $b i32) (param $metric i32) (result i32)
    (local $ra i32) (local $rb i32) (local $ka i32) (local $kb i32)
    (local.set $ra (i32.add (global.get $gRecBase) (i32.mul (local.get $a) (i32.const 128))))
    (local.set $rb (i32.add (global.get $gRecBase) (i32.mul (local.get $b) (i32.const 128))))
    (if (i32.eq (local.get $metric) (i32.const 0))
      (then
        (return (f64.lt
          (f64.add (f64.load (i32.add (local.get $ra) (i32.const 24)))
                   (f64.load (i32.add (local.get $ra) (i32.const 32))))
          (f64.add (f64.load (i32.add (local.get $rb) (i32.const 24)))
                   (f64.load (i32.add (local.get $rb) (i32.const 32))))))))
    (if (i32.eq (local.get $metric) (i32.const 1))
      (then
        (return (i32.lt_s (i32.load (i32.add (local.get $ra) (i32.const 16)))
                          (i32.load (i32.add (local.get $rb) (i32.const 16)))))))
    (if (i32.eq (local.get $metric) (i32.const 2))
      (then
        (local.set $ka (i32.load (i32.add (local.get $ra) (i32.const 40))))
        (local.set $kb (i32.load (i32.add (local.get $rb) (i32.const 40))))
        (if (i32.eq (local.get $ka) (i32.const 0)) (then (local.set $ka (i32.const 0x7FFFFFFF))))
        (if (i32.eq (local.get $kb) (i32.const 0)) (then (local.set $kb (i32.const 0x7FFFFFFF))))
        (return (i32.lt_s (local.get $ka) (local.get $kb)))))
    (if (i32.eq (local.get $metric) (i32.const 3))
      (then
        (local.set $ka (i32.load (i32.add (local.get $ra) (i32.const 44))))
        (local.set $kb (i32.load (i32.add (local.get $rb) (i32.const 44))))
        (if (i32.eq (local.get $ka) (i32.const 0)) (then (local.set $ka (i32.const 0x7FFFFFFF))))
        (if (i32.eq (local.get $kb) (i32.const 0)) (then (local.set $kb (i32.const 0x7FFFFFFF))))
        (return (i32.lt_s (local.get $ka) (local.get $kb)))))
    (i32.lt_s (i32.load (i32.add (local.get $ra) (i32.const 20)))
              (i32.load (i32.add (local.get $rb) (i32.const 20))))
  )

  ;; $cmplt — comparator with desc inversion
  (func $cmplt (param $a i32) (param $b i32) (param $metric i32) (param $desc i32) (result i32)
    (if (local.get $desc)
      (then (return (call $key_less (local.get $b) (local.get $a) (local.get $metric))))
      (else (return (call $key_less (local.get $a) (local.get $b) (local.get $metric)))))
    (i32.const 0)
  )

  ;; $isort — insertion sort tbl[lo..hi]
  (func $isort (param $tbl i32) (param $lo i32) (param $hi i32) (param $metric i32) (param $desc i32)
    (local $a i32) (local $b i32) (local $v i32)
    (if (i32.ge_s (local.get $lo) (local.get $hi)) (then (return)))
    (local.set $a (i32.add (local.get $lo) (i32.const 1)))
    (loop $a1
      (if (i32.gt_s (local.get $a) (local.get $hi)) (then (return)))
      (local.set $v (i32.load (i32.add (local.get $tbl) (i32.mul (local.get $a) (i32.const 4)))))
      (local.set $b (i32.sub (local.get $a) (i32.const 1)))
      (block $sh (loop $s1
        (br_if $sh (i32.lt_s (local.get $b) (local.get $lo)))
        (br_if $sh (i32.eqz (call $cmplt (local.get $v)
                             (i32.load (i32.add (local.get $tbl) (i32.mul (local.get $b) (i32.const 4))))
                             (local.get $metric) (local.get $desc))))
        (i32.store (i32.add (local.get $tbl) (i32.mul (i32.add (local.get $b) (i32.const 1)) (i32.const 4)))
          (i32.load (i32.add (local.get $tbl) (i32.mul (local.get $b) (i32.const 4)))))
        (local.set $b (i32.sub (local.get $b) (i32.const 1)))
        (br $s1)
      ))
      (i32.store (i32.add (local.get $tbl) (i32.mul (i32.add (local.get $b) (i32.const 1)) (i32.const 4)))
        (local.get $v))
      (local.set $a (i32.add (local.get $a) (i32.const 1)))
      (br $a1)
    )
  )

  ;; $qsort — Hoare quicksort, insertion cutoff ≤ 8, tail-recurse larger side
  (func $qsort (param $tbl i32) (param $lo i32) (param $hi i32) (param $metric i32) (param $desc i32)
    (local $piv i32) (local $i i32) (local $j i32) (local $t i32)
    (loop $outer
      (if (i32.gt_s (i32.sub (local.get $hi) (local.get $lo)) (i32.const 8))
        (then
          (local.set $piv
            (i32.load (i32.add (local.get $tbl)
              (i32.mul (i32.shr_u (i32.add (local.get $lo) (local.get $hi)) (i32.const 1)) (i32.const 4)))))
          (local.set $i (i32.sub (local.get $lo) (i32.const 1)))
          (local.set $j (i32.add (local.get $hi) (i32.const 1)))
          (loop $part
            (loop $li
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br_if $li (call $cmplt
                (i32.load (i32.add (local.get $tbl) (i32.mul (local.get $i) (i32.const 4))))
                (local.get $piv) (local.get $metric) (local.get $desc))))
            (loop $lj
              (local.set $j (i32.sub (local.get $j) (i32.const 1)))
              (br_if $lj (call $cmplt (local.get $piv)
                (i32.load (i32.add (local.get $tbl) (i32.mul (local.get $j) (i32.const 4))))
                (local.get $metric) (local.get $desc))))
            (if (i32.lt_s (local.get $i) (local.get $j))
              (then
                (local.set $t (i32.load (i32.add (local.get $tbl) (i32.mul (local.get $i) (i32.const 4)))))
                (i32.store (i32.add (local.get $tbl) (i32.mul (local.get $i) (i32.const 4)))
                  (i32.load (i32.add (local.get $tbl) (i32.mul (local.get $j) (i32.const 4)))))
                (i32.store (i32.add (local.get $tbl) (i32.mul (local.get $j) (i32.const 4)))
                  (local.get $t))))
            (br_if $part (i32.lt_s (local.get $i) (local.get $j)))
          )
          (if (i32.lt_s (i32.sub (local.get $j) (local.get $lo))
                        (i32.sub (local.get $hi) (local.get $j)))
            (then
              (call $qsort (local.get $tbl) (local.get $lo) (local.get $j) (local.get $metric) (local.get $desc))
              (local.set $lo (i32.add (local.get $j) (i32.const 1))))
            (else
              (call $qsort (local.get $tbl) (i32.add (local.get $j) (i32.const 1)) (local.get $hi)
                (local.get $metric) (local.get $desc))
              (local.set $hi (local.get $j))))
          (br $outer)))
    )
    (call $isort (local.get $tbl) (local.get $lo) (local.get $hi) (local.get $metric) (local.get $desc))
  )

  ;; ══════════════════════════ exports ═════════════════════════════════

  ;; init — zero control block, set bump pointers, write MAGIC
  (func (export "init")
    (memory.fill (i32.const 0) (i32.const 0) (i32.const 0x1000))
    (i32.store (i32.const 0x20000) (i32.const 0))
    (i32.store (i32.const 0x00) (global.get $gMagic))
    (i32.store (global.get $cHistBump) (global.get $gHistBase))
    (i32.store (global.get $cPoolBump) (global.get $gPoolBase))
    (i32.store (global.get $cHeapBump) (global.get $gHeapBase))
    (i32.store (global.get $cState) (i32.const 0))
  )

  ;; heap_alloc — bump allocator, grows memory, 0 on failure (cap 256 pages)
  (func $heap_alloc (export "heap_alloc") (param $len i32) (result i32)
    (local $aln i32) (local $addr i32) (local $endp i32) (local $cur i32) (local $need i32)
    (local.set $aln (i32.and (i32.add (local.get $len) (i32.const 7)) (i32.const -8)))
    (local.set $addr (i32.load (global.get $cHeapBump)))
    (local.set $endp (i32.add (local.get $addr) (local.get $aln)))
    (local.set $need (i32.shr_u (i32.add (local.get $endp) (i32.const 0xFFFF)) (i32.const 16)))
    (if (i32.gt_u (local.get $need) (i32.const 256)) (then (return (i32.const 0))))
    (local.set $cur (memory.size))
    (if (i32.gt_u (local.get $need) (local.get $cur))
      (then
        (if (i32.eq (memory.grow (i32.sub (local.get $need) (local.get $cur))) (i32.const -1))
          (then (return (i32.const 0))))))
    (i32.store (global.get $cHeapBump) (local.get $endp))
    (local.get $addr)
  )

  ;; memstats — 8×i32 snapshot for the HUD
  (func (export "memstats") (param $out i32)
    (i32.store (local.get $out) (i32.load (global.get $cState)))
    (i32.store (i32.add (local.get $out) (i32.const 4)) (i32.load (global.get $cMsgCnt)))
    (i32.store (i32.add (local.get $out) (i32.const 8)) (i32.load (global.get $cHeapBump)))
    (i32.store (i32.add (local.get $out) (i32.const 12)) (i32.load (global.get $cRendLen)))
    (i32.store (i32.add (local.get $out) (i32.const 16)) (i32.load (global.get $cModCnt)))
    (i32.store (i32.add (local.get $out) (i32.const 20)) (i32.load (global.get $cTokIn)))
    (i32.store (i32.add (local.get $out) (i32.const 24)) (i32.load (global.get $cTokOut)))
    (i32.store (i32.add (local.get $out) (i32.const 28)) (i32.load (global.get $cRendOvf)))
  )

  ;; scratch — JS staging area address
  (func (export "scratch") (result i32) (global.get $gScratch))


  (func (export "history_count") (result i32) (i32.load (global.get $cMsgCnt)))

  ;; history_get — write 9×i32 {role,cptr,clen,tptr,tlen,nptr,nlen,aptr,alen}
  (func (export "history_get") (param $i i32) (param $out i32)
    (local $e i32) (local $k i32) (local $clen i32) (local $tlen i32) (local $nlen i32) (local $alen i32)
    (if (i32.ge_u (local.get $i) (i32.load (global.get $cMsgCnt)))
      (then
        (memory.fill (local.get $out) (i32.const 0) (i32.const 36))
        (return)))
    (local.set $e (global.get $gHistBase))
    (local.set $k (i32.const 0))
    (block $walk (loop $w
      (br_if $walk (i32.ge_u (local.get $k) (local.get $i)))
      (local.set $e (i32.add (local.get $e) (i32.add (i32.const 20)
        (i32.add (i32.add (i32.load (i32.add (local.get $e) (i32.const 4))) (i32.load (i32.add (local.get $e) (i32.const 8))))
                 (i32.add (i32.load (i32.add (local.get $e) (i32.const 12))) (i32.load (i32.add (local.get $e) (i32.const 16))))))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $w)
    ))
    (local.set $clen (i32.load (i32.add (local.get $e) (i32.const 4))))
    (local.set $tlen (i32.load (i32.add (local.get $e) (i32.const 8))))
    (local.set $nlen (i32.load (i32.add (local.get $e) (i32.const 12))))
    (local.set $alen (i32.load (i32.add (local.get $e) (i32.const 16))))
    (i32.store (local.get $out) (i32.load (local.get $e)))
    (i32.store (i32.add (local.get $out) (i32.const 4)) (i32.add (local.get $e) (i32.const 20)))
    (i32.store (i32.add (local.get $out) (i32.const 8)) (local.get $clen))
    (i32.store (i32.add (local.get $out) (i32.const 12)) (i32.add (local.get $e) (i32.add (i32.const 20) (local.get $clen))))
    (i32.store (i32.add (local.get $out) (i32.const 16)) (local.get $tlen))
    (i32.store (i32.add (local.get $out) (i32.const 20))
      (i32.add (local.get $e) (i32.add (i32.add (i32.const 20) (local.get $clen)) (local.get $tlen))))
    (i32.store (i32.add (local.get $out) (i32.const 24)) (local.get $nlen))
    (i32.store (i32.add (local.get $out) (i32.const 28))
      (i32.add (local.get $e)
        (i32.add (i32.add (i32.const 20) (local.get $clen))
                 (i32.add (local.get $tlen) (local.get $nlen)))))
    (i32.store (i32.add (local.get $out) (i32.const 32)) (local.get $alen))
  )

  (func (export "history_clear")
    (i32.store (global.get $cHistBump) (global.get $gHistBase))
    (i32.store (global.get $cMsgCnt) (i32.const 0))
  )

  ;; render buffer accessors
  (func (export "render_ptr") (result i32) (global.get $gRendBuf))
  (func (export "render_len") (result i32) (i32.load (global.get $cRendLen)))
  (func (export "render_reset") (i32.store (global.get $cRendLen) (i32.const 0)))

  ;; begin_turn — reset per-turn accumulators, state=STREAMING
  (func (export "begin_turn")
    (i32.store (global.get $cState) (i32.const 1))
    (i32.store (global.get $cCurPtr) (i32.const 0))
    (i32.store (global.get $cCurLen) (i32.const 0))
    (i32.store (global.get $cCurCap) (i32.const 0))
    (call $tc_reset)
    (i32.store (global.get $cTrPtr) (i32.const 0))
    (i32.store (global.get $cTrLen) (i32.const 0))
    (i32.store (global.get $cTrCap) (i32.const 0))
    (i32.store (global.get $cRemLen) (i32.const 0))
    (i32.store (global.get $gDrop) (i32.const 0))
  )

  ;; sse_feed — byte-level SSE/JSON scanner over [ptr, ptr+len)
  (func (export "sse_feed") (param $ptr i32) (param $len i32)
    (local $i i32) (local $b i32) (local $rl i32)
    (local.set $i (i32.const 0))
    (block $fin (loop $l
      (br_if $fin (i32.ge_u (local.get $i) (local.get $len)))
      (local.set $b (i32.load8_u (i32.add (local.get $ptr) (local.get $i))))
      (if (i32.load (global.get $gDrop))
        (then
          (if (i32.eq (local.get $b) (i32.const 10))
            (then
              (i32.store (global.get $gDrop) (i32.const 0))
              (i32.store (global.get $cRemLen) (i32.const 0))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $l)))
      (if (i32.eq (local.get $b) (i32.const 10))
        (then
          (local.set $rl (i32.load (global.get $cRemLen)))
          (if (i32.and (i32.gt_u (local.get $rl) (i32.const 0))
                       (i32.eq (i32.load8_u (i32.add (global.get $gRemBuf) (i32.sub (local.get $rl) (i32.const 1)))) (i32.const 13)))
            (then (local.set $rl (i32.sub (local.get $rl) (i32.const 1)))))
          (call $process_line (global.get $gRemBuf) (local.get $rl))
          (i32.store (global.get $cRemLen) (i32.const 0)))
        (else
          (if (i32.ge_u (i32.load (global.get $cRemLen)) (i32.const 0x4000))
            (then
              (i32.store (global.get $gDrop) (i32.const 1))
              (i32.store (global.get $cErrCode) (i32.const 3)))
            (else
              (i32.store8 (i32.add (global.get $gRemBuf) (i32.load (global.get $cRemLen))) (local.get $b))
              (i32.store (global.get $cRemLen) (i32.add (i32.load (global.get $cRemLen)) (i32.const 1)))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $l)
    ))
  )

  ;; $process_line — one complete SSE line (CR stripped)
  (func $process_line (param $ptr i32) (param $len i32)
    (local $pay i32) (local $plen i32) (local $end i32) (local $off i32)
    (local $ep i32) (local $mp i32) (local $dp i32) (local $cp i32) (local $tp i32)
    (local $s i32) (local $e i32) (local $dlen i32)
    (local $rem i32) (local $ap i32) (local $hp i32) (local $lim i32)
    (local $pid i32) (local $pnm i32) (local $parg i32)
    (local $best i32) (local $kind i32) (local $slot i32)
    ;; strip trailing CR
    (if (i32.and (i32.gt_u (local.get $len) (i32.const 0))
                 (i32.eq (i32.load8_u (i32.add (local.get $ptr) (i32.sub (local.get $len) (i32.const 1)))) (i32.const 13)))
      (then (local.set $len (i32.sub (local.get $len) (i32.const 1)))))
    (if (i32.lt_u (local.get $len) (i32.const 5)) (then (return)))
    ;; require "data" prefix
    (if (i32.ne (i32.load8_u (local.get $ptr)) (i32.const 100)) (then (return)))
    (if (i32.ne (i32.load8_u (i32.add (local.get $ptr) (i32.const 1))) (i32.const 97)) (then (return)))
    (if (i32.ne (i32.load8_u (i32.add (local.get $ptr) (i32.const 2))) (i32.const 116)) (then (return)))
    (if (i32.ne (i32.load8_u (i32.add (local.get $ptr) (i32.const 3))) (i32.const 97)) (then (return)))
    (if (i32.ne (i32.load8_u (i32.add (local.get $ptr) (i32.const 4))) (i32.const 58)) (then (return)))
    (local.set $off (i32.const 5))
    (if (i32.and (i32.gt_u (local.get $len) (i32.const 5))
                 (i32.eq (i32.load8_u (i32.add (local.get $ptr) (i32.const 5))) (i32.const 32)))
      (then (local.set $off (i32.const 6))))
    (local.set $pay (i32.add (local.get $ptr) (local.get $off)))
    (local.set $plen (i32.sub (local.get $len) (local.get $off)))
    (if (i32.eqz (local.get $plen)) (then (return)))
    (local.set $end (i32.add (local.get $pay) (local.get $plen)))
    ;; data: [DONE]
    (if (i32.eq (call $find (local.get $pay) (local.get $plen) (i32.const 0x70010) (i32.const 6)) (local.get $pay))
      (then
        (i32.store (global.get $cState) (i32.const 2))
        (return)))
    ;; must look like a JSON object
    (if (i32.ne (i32.load8_u (local.get $pay)) (i32.const 123)) (then (return)))
    ;; ── error event ──
    (local.set $ep (call $find (local.get $pay) (local.get $plen) (i32.const 0x70080) (i32.const 7)))
    (if (i32.ge_s (local.get $ep) (i32.const 0))
      (then
        (local.set $mp (call $find (local.get $ep) (i32.sub (local.get $end) (local.get $ep)) (i32.const 0x70090) (i32.const 11)))
        (if (i32.ge_s (local.get $mp) (i32.const 0))
          (then
            (local.set $s (i32.add (local.get $mp) (i32.const 11)))
            (local.set $e (call $scan_quote (local.get $s) (local.get $end)))
            (local.set $dlen (call $decode_inplace (local.get $s) (local.get $e)))
            (local.set $hp (call $heap_alloc (local.get $dlen)))
            (if (i32.ne (local.get $hp) (i32.const 0))
              (then
                (memory.copy (local.get $hp) (local.get $s) (local.get $dlen))
                (i32.store (global.get $cErrPtr) (local.get $hp))
                (i32.store (global.get $cErrLen) (local.get $dlen))))))
        (i32.store (global.get $cState) (i32.const 3))
        (i32.store (global.get $cErrCode) (i32.const 1))
        (return)))
    ;; ── delta + tool_calls (find both on the pristine line) ──
    (local.set $dp (call $find (local.get $pay) (local.get $plen) (i32.const 0x70020) (i32.const 7)))
    (local.set $tp (call $find (local.get $pay) (local.get $plen) (i32.const 0x70040) (i32.const 12)))
    (if (i32.lt_s (local.get $dp) (i32.const 0))
      (then (if (i32.lt_s (local.get $tp) (i32.const 0)) (then (return)))))
    ;; ── tool_calls: one left-to-right walk from $tp to end of line ──
    ;; Needles are handled in the order they appear, never per needle kind, so
    ;; a provider that packs several complete calls onto one line behaves the
    ;; same as one that streams a fragment per line. `"id":"` opens the next
    ;; slot; `"name":"` and `"arguments":"` land on the slot open at that
    ;; point. The walk starts at $tp so the chunk's own outer `"id"` — which
    ;; sits before "tool_calls" on every observed line — is never mistaken for
    ;; a call id. $decode_inplace shrinks each value in place; advancing to
    ;; $e + 1 steps over the stale tail as well as the closing quote, so the
    ;; leftovers can never be re-scanned as a needle.
    ;; (Runs before the delta-content branch: decode writes stay in this region.)
    (if (i32.ge_s (local.get $tp) (i32.const 0))
      (then
        (local.set $ap (local.get $tp))
        (block $tcw (loop $tcl
          (local.set $rem (i32.sub (local.get $end) (local.get $ap)))
          (br_if $tcw (i32.le_s (local.get $rem) (i32.const 0)))
          (local.set $pid  (call $find (local.get $ap) (local.get $rem) (i32.const 0x70050) (i32.const 6)))
          (local.set $pnm  (call $find (local.get $ap) (local.get $rem) (i32.const 0x70060) (i32.const 8)))
          (local.set $parg (call $find (local.get $ap) (local.get $rem) (i32.const 0x70070) (i32.const 13)))
          ;; earliest needle wins; kind 0 means none left on this line
          (local.set $best (i32.const -1))
          (local.set $kind (i32.const 0))
          (if (i32.ge_s (local.get $pid) (i32.const 0))
            (then (local.set $best (local.get $pid)) (local.set $kind (i32.const 1))))
          (if (i32.and (i32.ge_s (local.get $pnm) (i32.const 0))
                       (i32.or (i32.lt_s (local.get $best) (i32.const 0))
                               (i32.lt_u (local.get $pnm) (local.get $best))))
            (then (local.set $best (local.get $pnm)) (local.set $kind (i32.const 2))))
          (if (i32.and (i32.ge_s (local.get $parg) (i32.const 0))
                       (i32.or (i32.lt_s (local.get $best) (i32.const 0))
                               (i32.lt_u (local.get $parg) (local.get $best))))
            (then (local.set $best (local.get $parg)) (local.set $kind (i32.const 3))))
          (br_if $tcw (i32.eqz (local.get $kind)))
          ;; value body sits right after the needle: 6 / 8 / 13 bytes
          (local.set $s (i32.add (local.get $best)
            (select (i32.const 6)
                    (select (i32.const 8) (i32.const 13) (i32.eq (local.get $kind) (i32.const 2)))
                    (i32.eq (local.get $kind) (i32.const 1)))))
          (local.set $e (call $scan_quote (local.get $s) (local.get $end)))
          (local.set $dlen (call $decode_inplace (local.get $s) (local.get $e)))
          ;; "id" — open the next slot. An empty id can key no role-3 entry, so
          ;; it opens nothing and leaves tool_pending false, as before the table.
          (if (i32.and (i32.eq (local.get $kind) (i32.const 1)) (i32.gt_u (local.get $dlen) (i32.const 0)))
            (then
              (if (i32.ge_u (i32.load (global.get $cTcCount)) (global.get $gTcMax))
                (then
                  (i32.store (global.get $cTcOvf)
                    (i32.add (i32.load (global.get $cTcOvf)) (i32.const 1))))
                (else
                  (local.set $slot (i32.load (global.get $cTcCount)))
                  (i32.store (global.get $cTcCount) (i32.add (local.get $slot) (i32.const 1)))
                  (call $tc_store (call $tc_id (local.get $slot)) (call $tc_id_len (local.get $slot))
                                  (local.get $s) (local.get $dlen))))))
          ;; "name" — first name wins for the open slot
          (if (i32.eq (local.get $kind) (i32.const 2))
            (then
              (local.set $slot (call $tc_open))
              (if (i32.ge_s (local.get $slot) (i32.const 0))
                (then
                  (if (i32.eqz (i32.load (call $tc_name_len (local.get $slot))))
                    (then
                      (call $tc_store (call $tc_name (local.get $slot)) (call $tc_name_len (local.get $slot))
                                      (local.get $s) (local.get $dlen))))))))
          ;; "arguments" — append the fragment to the open slot's accumulator
          (if (i32.eq (local.get $kind) (i32.const 3))
            (then
              (local.set $slot (call $tc_open))
              (if (i32.and (i32.ge_s (local.get $slot) (i32.const 0))
                           (i32.gt_u (local.get $dlen) (i32.const 0)))
                (then
                  (call $accum_append
                    (call $tc_args_ptr (local.get $slot))
                    (call $tc_args_len (local.get $slot))
                    (call $tc_args_cap (local.get $slot))
                    (local.get $s) (local.get $dlen))))))
          (local.set $ap (i32.add (local.get $e) (i32.const 1)))
          (br $tcl)
        ))
    ))
    ;; delta content — bounded to [dp, tp) so decoded tool args can't fool it.
    ;; Only clamp when "tool_calls" sits AFTER "delta": a line that carries the
    ;; string as a finish_reason value ahead of the delta would otherwise make
    ;; $rem negative, and $find reads it unsigned.
    (if (i32.ge_s (local.get $dp) (i32.const 0))
      (then
        (local.set $lim (local.get $end))
        (if (i32.and (i32.gt_u (local.get $tp) (local.get $dp))
                     (i32.lt_u (local.get $tp) (local.get $end)))
          (then (local.set $lim (local.get $tp))))
        (local.set $rem (i32.sub (local.get $lim) (local.get $dp)))
        (if (i32.gt_s (local.get $rem) (i32.const 10))
          (then
            (local.set $cp (call $find (local.get $dp) (local.get $rem) (i32.const 0x70030) (i32.const 11)))
            (if (i32.ge_s (local.get $cp) (i32.const 0))
              (then
                (local.set $s (i32.add (local.get $cp) (i32.const 11)))
                (local.set $e (call $scan_quote (local.get $s) (local.get $lim)))
                (local.set $dlen (call $decode_inplace (local.get $s) (local.get $e)))
                (if (i32.gt_u (local.get $dlen) (i32.const 0))
                  (then
                    (call $accum_append (global.get $cCurPtr) (global.get $cCurLen) (global.get $cCurCap)
                                         (local.get $s) (local.get $dlen))
                    (call $render_append (local.get $s) (local.get $dlen))
                    (i32.store (global.get $cTokOut)
                      (i32.add (i32.load (global.get $cTokOut))
                        (i32.shr_u (local.get $dlen) (i32.const 2))))))))))))
  )

  ;; end_turn — finalize assistant history entry (keeps tool meta for bridge)
  (func (export "end_turn")
    (call $hist_append
      (i32.const 2)
      (i32.load (global.get $cCurPtr)) (i32.load (global.get $cCurLen))
      (global.get $gTcid) (i32.load (global.get $cTcidLen))
      (global.get $gTcName) (i32.load (global.get $cTcNameLen))
      (i32.load (global.get $cTaPtr)) (i32.load (global.get $cTaLen)))
    (i32.store (global.get $cCurPtr) (i32.const 0))
    (i32.store (global.get $cCurLen) (i32.const 0))
    (i32.store (global.get $cCurCap) (i32.const 0))
    (i32.store (global.get $cState) (i32.const 0))
  )

  ;; real history_append body (shared by export + end_turn)
  (func $hist_append
    (param $role i32) (param $cptr i32) (param $clen i32)
    (param $tptr i32) (param $tlen i32)
    (param $nptr i32) (param $nlen i32)
    (param $aptr i32) (param $alen i32)
    (local $need i32) (local $e i32) (local $dst i32)
    (local.set $need (i32.add (i32.const 20)
      (i32.add (i32.add (local.get $clen) (local.get $tlen))
               (i32.add (local.get $nlen) (local.get $alen)))))
    (if (i32.gt_u (i32.add (i32.load (global.get $cHistBump)) (local.get $need)) (global.get $gHistEnd))
      (then
        (i32.store (global.get $cState) (i32.const 3))
        (i32.store (global.get $cErrCode) (i32.const 2))
        (return)))
    (local.set $e (i32.load (global.get $cHistBump)))
    (i32.store (local.get $e) (local.get $role))
    (i32.store (i32.add (local.get $e) (i32.const 4)) (local.get $clen))
    (i32.store (i32.add (local.get $e) (i32.const 8)) (local.get $tlen))
    (i32.store (i32.add (local.get $e) (i32.const 12)) (local.get $nlen))
    (i32.store (i32.add (local.get $e) (i32.const 16)) (local.get $alen))
    (local.set $dst (i32.add (local.get $e) (i32.const 20)))
    (if (i32.gt_u (local.get $clen) (i32.const 0))
      (then (memory.copy (local.get $dst) (local.get $cptr) (local.get $clen))
            (local.set $dst (i32.add (local.get $dst) (local.get $clen)))))
    (if (i32.gt_u (local.get $tlen) (i32.const 0))
      (then (memory.copy (local.get $dst) (local.get $tptr) (local.get $tlen))
            (local.set $dst (i32.add (local.get $dst) (local.get $tlen)))))
    (if (i32.gt_u (local.get $nlen) (i32.const 0))
      (then (memory.copy (local.get $dst) (local.get $nptr) (local.get $nlen))
            (local.set $dst (i32.add (local.get $dst) (local.get $nlen)))))
    (if (i32.gt_u (local.get $alen) (i32.const 0))
      (then (memory.copy (local.get $dst) (local.get $aptr) (local.get $alen))))
    (i32.store (global.get $cHistBump) (i32.add (local.get $e) (local.get $need)))
    (i32.store (global.get $cMsgCnt) (i32.add (i32.load (global.get $cMsgCnt)) (i32.const 1)))
    (if (i32.ne (local.get $role) (i32.const 2))
      (then
        (i32.store (global.get $cTokIn)
          (i32.add (i32.load (global.get $cTokIn))
            (i32.shr_u (i32.add (local.get $clen) (local.get $alen)) (i32.const 2))))))
  )

  ;; exported history_append forwards to the shared body
  (func (export "history_append")
    (param $role i32) (param $cptr i32) (param $clen i32)
    (param $tptr i32) (param $tlen i32)
    (param $nptr i32) (param $nlen i32)
    (param $aptr i32) (param $alen i32)
    (call $hist_append (local.get $role) (local.get $cptr) (local.get $clen)
      (local.get $tptr) (local.get $tlen) (local.get $nptr) (local.get $nlen)
      (local.get $aptr) (local.get $alen))
  )

  (func (export "tool_pending") (result i32)
    (i32.gt_u (i32.load (global.get $cTcCount)) (i32.const 0))
  )

  ;; tc_count — tool calls staged this turn (0..8; extras counted in cTcOvf)
  (func (export "tc_count") (result i32) (i32.load (global.get $cTcCount)))

  ;; tc_get — write 6×i32 {idPtr,idLen,namePtr,nameLen,argsPtr,argsLen}
  (func (export "tc_get") (param $i i32) (param $out i32)
    (if (i32.ge_u (local.get $i) (i32.load (global.get $cTcCount)))
      (then
        (memory.fill (local.get $out) (i32.const 0) (i32.const 24))
        (return)))
    (i32.store (local.get $out) (call $tc_id (local.get $i)))
    (i32.store (i32.add (local.get $out) (i32.const 4))
      (i32.load (call $tc_id_len (local.get $i))))
    (i32.store (i32.add (local.get $out) (i32.const 8)) (call $tc_name (local.get $i)))
    (i32.store (i32.add (local.get $out) (i32.const 12))
      (i32.load (call $tc_name_len (local.get $i))))
    (i32.store (i32.add (local.get $out) (i32.const 16))
      (i32.load (call $tc_args_ptr (local.get $i))))
    (i32.store (i32.add (local.get $out) (i32.const 20))
      (i32.load (call $tc_args_len (local.get $i))))
  )

  (func (export "tool_result_append") (param $ptr i32) (param $len i32)
    (call $accum_append (global.get $cTrPtr) (global.get $cTrLen) (global.get $cTrCap)
      (local.get $ptr) (local.get $len))
  )

  ;; tool_result_flush — append role-3 entry carrying the pending tcid/name
  (func (export "tool_result_flush")
    (if (i32.gt_u (i32.load (global.get $cTrLen)) (i32.const 0))
      (then
        (call $hist_append (i32.const 3)
          (i32.load (global.get $cTrPtr)) (i32.load (global.get $cTrLen))
          (global.get $gTcid) (i32.load (global.get $cTcidLen))
          (global.get $gTcName) (i32.load (global.get $cTcNameLen))
          (i32.const 0) (i32.const 0))
        (i32.store (global.get $cTrPtr) (i32.const 0))
        (i32.store (global.get $cTrLen) (i32.const 0))
        (i32.store (global.get $cTrCap) (i32.const 0))))
  )

  ;; ══════════════════════════ model catalog ══════════════════════════

  ;; models_load — parse TLV blob at [ptr,ptr+len), build records + tables
  ;; TLV: [u32 count] then per model, fixed order:
  ;;   01 id[u16 len][bytes]  02 name[...]  03 ctx u32  04 created u32
  ;;   05 price_prompt f64    06 price_completion f64  07 flags u32
  ;;   08 latency_rank u32    09 throughput_rank u32
  (func (export "models_load") (param $ptr i32) (param $len i32) (result i32)
    (local $n i32) (local $c i32) (local $end i32) (local $i i32) (local $t i32)
    (local $l i32) (local $dst i32) (local $rec i32) (local $bad i32)
    (local $mi i32) (local $tbl i32) (local $j i32) (local $desc i32)
    (i32.store (global.get $cPoolBump) (global.get $gPoolBase))
    (i32.store (global.get $cModCnt) (i32.const 0))
    (i32.store (global.get $gRecCnt) (i32.const 0))
    (if (i32.lt_u (local.get $len) (i32.const 4)) (then (return (i32.const 0))))
    (local.set $end (i32.add (local.get $ptr) (local.get $len)))
    (local.set $n (i32.load (local.get $ptr)))
    (if (i32.gt_u (local.get $n) (i32.const 512)) (then (local.set $n (i32.const 512))))
    (local.set $c (i32.add (local.get $ptr) (i32.const 4)))
    (local.set $i (i32.const 0))
    (block $models (loop $ml
      (br_if $models (i32.ge_u (local.get $i) (local.get $n)))
      (br_if $models (i32.gt_u (local.get $bad) (i32.const 0)))
      (local.set $rec (i32.add (global.get $gRecBase) (i32.mul (local.get $i) (i32.const 128))))
      (memory.fill (local.get $rec) (i32.const 0) (i32.const 128))
      (local.set $t (i32.const 1))
      (block $tags (loop $tl
        (br_if $tags (i32.gt_u (local.get $t) (i32.const 9)))
        (if (i32.ge_u (local.get $c) (local.get $end))
          (then (local.set $bad (i32.const 1)) (br $tags)))
        (if (i32.ne (i32.load8_u (local.get $c)) (local.get $t))
          (then (local.set $bad (i32.const 1)) (br $tags)))
        (if (i32.or (i32.eq (local.get $t) (i32.const 1)) (i32.eq (local.get $t) (i32.const 2)))
          (then ;; string tag
            (if (i32.gt_u (i32.add (local.get $c) (i32.const 3)) (local.get $end))
              (then (local.set $bad (i32.const 1)) (br $tags)))
            (local.set $l (i32.load16_u (i32.add (local.get $c) (i32.const 1))))
            (if (i32.gt_u (i32.add (i32.add (local.get $c) (i32.const 3)) (local.get $l)) (local.get $end))
              (then (local.set $bad (i32.const 1)) (br $tags)))
            (local.set $dst (i32.load (global.get $cPoolBump)))
            (if (i32.gt_u (i32.add (local.get $dst) (local.get $l)) (global.get $gPoolEnd))
              (then
                (i32.store (global.get $cErrCode) (i32.const 4))
                (local.set $bad (i32.const 1))
                (br $tags)))
            (memory.copy (local.get $dst) (i32.add (local.get $c) (i32.const 3)) (local.get $l))
            (i32.store (global.get $cPoolBump) (i32.add (local.get $dst) (local.get $l)))
            (if (i32.eq (local.get $t) (i32.const 1))
              (then
                (i32.store (local.get $rec) (local.get $dst))
                (i32.store (i32.add (local.get $rec) (i32.const 4)) (local.get $l)))
              (else
                (i32.store (i32.add (local.get $rec) (i32.const 8)) (local.get $dst))
                (i32.store (i32.add (local.get $rec) (i32.const 12)) (local.get $l))))
            (local.set $c (i32.add (i32.add (local.get $c) (i32.const 3)) (local.get $l)))))
        (if (i32.or (i32.or (i32.eq (local.get $t) (i32.const 3)) (i32.eq (local.get $t) (i32.const 4)))
                    (i32.or (i32.or (i32.eq (local.get $t) (i32.const 7)) (i32.eq (local.get $t) (i32.const 8)))
                            (i32.eq (local.get $t) (i32.const 9))))
          (then ;; u32 tag
            (if (i32.gt_u (i32.add (local.get $c) (i32.const 5)) (local.get $end))
              (then (local.set $bad (i32.const 1)) (br $tags)))
            (if (i32.eq (local.get $t) (i32.const 3))
              (then (i32.store (i32.add (local.get $rec) (i32.const 16)) (i32.load (i32.add (local.get $c) (i32.const 1))))))
            (if (i32.eq (local.get $t) (i32.const 4))
              (then (i32.store (i32.add (local.get $rec) (i32.const 20)) (i32.load (i32.add (local.get $c) (i32.const 1))))))
            (if (i32.eq (local.get $t) (i32.const 7))
              (then (i32.store (i32.add (local.get $rec) (i32.const 48)) (i32.load (i32.add (local.get $c) (i32.const 1))))))
            (if (i32.eq (local.get $t) (i32.const 8))
              (then (i32.store (i32.add (local.get $rec) (i32.const 40)) (i32.load (i32.add (local.get $c) (i32.const 1))))))
            (if (i32.eq (local.get $t) (i32.const 9))
              (then (i32.store (i32.add (local.get $rec) (i32.const 44)) (i32.load (i32.add (local.get $c) (i32.const 1))))))
            (local.set $c (i32.add (local.get $c) (i32.const 5)))))
        (if (i32.or (i32.eq (local.get $t) (i32.const 5)) (i32.eq (local.get $t) (i32.const 6)))
          (then ;; f64 tag
            (if (i32.gt_u (i32.add (local.get $c) (i32.const 9)) (local.get $end))
              (then (local.set $bad (i32.const 1)) (br $tags)))
            (if (i32.eq (local.get $t) (i32.const 5))
              (then (f64.store (i32.add (local.get $rec) (i32.const 24)) (f64.load (i32.add (local.get $c) (i32.const 1))))))
            (if (i32.eq (local.get $t) (i32.const 6))
              (then (f64.store (i32.add (local.get $rec) (i32.const 32)) (f64.load (i32.add (local.get $c) (i32.const 1))))))
            (local.set $c (i32.add (local.get $c) (i32.const 9)))))
        (local.set $t (i32.add (local.get $t) (i32.const 1)))
        (br $tl)
      ))
      (if (i32.eqz (local.get $bad))
        (then
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br $ml)))
    ))
    (if (i32.gt_u (local.get $bad) (i32.const 0))
      (then (i32.store (global.get $cErrCode) (i32.const 5))))
    ;; build the 5 index tables with default directions
    (local.set $mi (i32.const 0))
    (block $tbdone (loop $tb
      (if (i32.ge_u (local.get $mi) (i32.const 5)) (then (br $tbdone)))
      (local.set $tbl (i32.add (global.get $gTblBase) (i32.mul (local.get $mi) (i32.const 0x800))))
      (local.set $j (i32.const 0))
      (block $fill (loop $fl
        (br_if $fill (i32.ge_u (local.get $j) (local.get $n)))
        (i32.store (i32.add (local.get $tbl) (i32.mul (local.get $j) (i32.const 4))) (local.get $j))
        (local.set $j (i32.add (local.get $j) (i32.const 1)))
        (br $fl)
      ))
      (local.set $desc (select (i32.const 1) (i32.const 0) (i32.or
        (i32.eq (local.get $mi) (i32.const 1))
        (i32.eq (local.get $mi) (i32.const 4)))))
      (call $qsort (local.get $tbl) (i32.const 0) (i32.sub (local.get $n) (i32.const 1))
        (local.get $mi) (local.get $desc))
      (local.set $mi (i32.add (local.get $mi) (i32.const 1)))
      (br $tb)
    ))
    (i32.store (global.get $cModCnt) (local.get $n))
    (i32.store (global.get $gRecCnt) (local.get $n))
    (i32.store (global.get $cActTbl) (i32.const 0x42000))
    (local.get $n)
  )

  ;; models_sort — sort index table for metric (0..4), desc inverts
  (func (export "models_sort") (param $metric i32) (param $desc i32)
    (local $tbl i32) (local $n i32)
    (if (i32.gt_s (local.get $metric) (i32.const 4)) (then (return)))
    (if (i32.lt_s (local.get $metric) (i32.const 0)) (then (return)))
    (local.set $n (i32.load (global.get $cModCnt)))
    (if (i32.le_u (local.get $n) (i32.const 1)) (then (return)))
    (local.set $tbl (i32.add (global.get $gTblBase) (i32.mul (local.get $metric) (i32.const 0x800))))
    (call $qsort (local.get $tbl) (i32.const 0) (i32.sub (local.get $n) (i32.const 1))
      (local.get $metric) (local.get $desc))
    (i32.store (global.get $cActTbl) (local.get $tbl))
  )

  ;; models_filter — mask bits: 1 free, 2 vision, 4 reasoning, 8 tools,
  ;; 16 ctx>=128K, 32 tps top-20. Query = ASCII-folded substring. Walks the
  ;; ACTIVE table so filter respects the current sort. Returns count.
  (func (export "models_filter") (param $mask i32) (param $qptr i32) (param $qlen i32) (result i32)
    (local $n i32) (local $at i32) (local $k i32) (local $idx i32) (local $rec i32)
    (local $pass i32) (local $cnt i32) (local $wp i32) (local $ql i32) (local $x i32)
    (local $ps i32) (local $ns i32)
    (local.set $n (i32.load (global.get $cModCnt)))
    (local.set $at (i32.load (global.get $cActTbl)))
    (local.set $wp (global.get $gTblFil))
    (local.set $cnt (i32.const 0))
    (local.set $ql (select (local.get $qlen) (i32.const 0x800) (i32.lt_u (local.get $qlen) (i32.const 0x800))))
    ;; fold query into the fold buffer
    (local.set $x (i32.const 0))
    (block $fq (loop $f1
      (br_if $fq (i32.ge_u (local.get $x) (local.get $ql)))
      (i32.store8 (i32.add (global.get $gFoldBuf) (local.get $x))
        (call $fold (i32.load8_u (i32.add (local.get $qptr) (local.get $x)))))
      (local.set $x (i32.add (local.get $x) (i32.const 1)))
      (br $f1)
    ))
    (local.set $k (i32.const 0))
    (block $sc (loop $sl2
      (br_if $sc (i32.ge_u (local.get $k) (local.get $n)))
      (local.set $idx (i32.load (i32.add (local.get $at) (i32.mul (local.get $k) (i32.const 4)))))
      (local.set $rec (i32.add (global.get $gRecBase) (i32.mul (local.get $idx) (i32.const 128))))
      (local.set $pass (i32.const 1))
      (if (i32.and (local.get $mask) (i32.const 1))
        (then (if (i32.eqz (i32.and (i32.load (i32.add (local.get $rec) (i32.const 48))) (i32.const 1)))
          (then (local.set $pass (i32.const 0))))))
      (if (i32.and (local.get $mask) (i32.const 2))
        (then (if (i32.eqz (i32.and (i32.load (i32.add (local.get $rec) (i32.const 48))) (i32.const 2)))
          (then (local.set $pass (i32.const 0))))))
      (if (i32.and (local.get $mask) (i32.const 4))
        (then (if (i32.eqz (i32.and (i32.load (i32.add (local.get $rec) (i32.const 48))) (i32.const 4)))
          (then (local.set $pass (i32.const 0))))))
      (if (i32.and (local.get $mask) (i32.const 8))
        (then (if (i32.eqz (i32.and (i32.load (i32.add (local.get $rec) (i32.const 48))) (i32.const 8)))
          (then (local.set $pass (i32.const 0))))))
      (if (i32.and (local.get $mask) (i32.const 16))
        (then (if (i32.lt_u (i32.load (i32.add (local.get $rec) (i32.const 16))) (i32.const 131072))
          (then (local.set $pass (i32.const 0))))))
      (if (i32.and (local.get $mask) (i32.const 32))
        (then
          (local.set $x (i32.load (i32.add (local.get $rec) (i32.const 44))))
          (if (i32.or (i32.eqz (local.get $x)) (i32.gt_u (local.get $x) (i32.const 20)))
            (then (local.set $pass (i32.const 0))))))
      (if (local.get $pass)
        (then
          (if (i32.gt_u (local.get $ql) (i32.const 0))
            (then
              (local.set $pass
                (i32.or
                  (call $folded_contains
                    (i32.load (local.get $rec)) (i32.load (i32.add (local.get $rec) (i32.const 4)))
                    (global.get $gFoldBuf) (local.get $ql))
                  (call $folded_contains
                    (i32.load (i32.add (local.get $rec) (i32.const 8))) (i32.load (i32.add (local.get $rec) (i32.const 12)))
                    (global.get $gFoldBuf) (local.get $ql))))))))
      (if (local.get $pass)
        (then
          (i32.store (local.get $wp) (local.get $idx))
          (local.set $wp (i32.add (local.get $wp) (i32.const 4)))
          (local.set $cnt (i32.add (local.get $cnt) (i32.const 1)))))
      (local.set $k (i32.add (local.get $k) (i32.const 1)))
      (br $sl2)
    ))
    (i32.store (global.get $cFilCnt) (local.get $cnt))
    (local.get $cnt)
  )

  ;; models_visible_rec — record address of filtered[i]
  (func (export "models_visible_rec") (param $i i32) (result i32)
    (i32.add (global.get $gRecBase)
      (i32.mul
        (i32.load (i32.add (global.get $gTblFil) (i32.mul (local.get $i) (i32.const 4))))
        (i32.const 128)))
  )

  (func (export "err_ptr") (result i32) (i32.load (global.get $cErrPtr)))
  (func (export "err_len") (result i32) (i32.load (global.get $cErrLen)))
)
