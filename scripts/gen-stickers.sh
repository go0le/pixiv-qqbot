#!/usr/bin/env bash
# 用本机 agy 的 generate_image，以设定图为唯一参考，批量生成哈Gemi 的 Q 版表情贴图。
# 只用自己的设定图做参考，不借用他人作品。生成原图放在 $OUT/raw/，之后用 scripts/finish-stickers.py 去底、描边。
# 用法：sudo -u MIKU bash scripts/gen-stickers.sh [并发数，默认 3] [只生成这些 id，逗号分隔]
set -uo pipefail
OUT=${STICKER_OUT:-/tmp/stkgen}
REF_SHEET=$OUT/ref_sheet.jpg
REF_FACE=$OUT/ref_face.png
PAR=${1:-3}
ONLY=${2:-}
AGY=/home/MIKU/.local/bin/agy
mkdir -p "$OUT/raw" "$OUT/log"

CHAR='the exact same character as the references: blue-to-purple long wavy hair with pink tips, an ahoge, two hair buns, blue cat ears with pink inner fur, a rainbow iridescent four-pointed star hair ornament on the side of her head with a small star below it, heterochromia eyes (pink eye on the viewer-left, amber eye on the viewer-right), navy and white outfit with a four-pointed star on the chest, white off-shoulder sleeves, fluffy blue-purple cat tail'
STYLE='A cute chibi-style anime chat sticker (LINE/Telegram sticker style, big head small body, thick clean dark outline, soft cel shading, pastel colors)'
TAIL='Centered, the whole character fits inside the frame with margin, pure white background, no text, no letters, no speech bubble, no border, no frame.'

# id|情绪描述
JOBS=$(cat <<'EOF'
natural|gentle closed-mouth smile, relaxed and friendly, slight head tilt, upper body
calm|calm neutral expression, small soft smile, hands together in front, upper body
surprise|surprised, eyes wide open, small round open mouth, cat ears perked up, hands raised near face, upper body
shy|shy and blushing, both hands covering her cheeks, eyes looking away, small embarrassed smile, upper body
pout|pouting with puffed cheeks, annoyed frown, arms crossed, small anger mark near head, upper body
giggle|giggling with eyes closed in happy upturned arcs, one hand covering her mouth, upper body
serious|serious determined expression, raising one index finger as if explaining, confident, upper body
upset|teary-eyed and wronged, trembling wavy mouth, holding tears back, ears drooping, upper body
happy|very happy, big open-mouth smile, both arms raised in cheer, sparkles around, upper body
confused|confused, head tilted, one finger on cheek, three question marks floating around her head, upper body
cry|crying loudly with streams of cartoon tears, mouth wide open, sitting, full body
smug|smug proud grin, half-lidded eyes, hand on chin, upper body
sparkle|excited sparkling star-shaped eyes, hands clasped together, expecting something, upper body
sleepy|sleepy, yawning with one eye closed, rubbing an eye with her paw-like sleeve, upper body
love|making a heart shape with both hands, happy smile, small hearts floating, upper body
ok|cheerful, winking, giving a thumbs up, upper body
speechless|speechless deadpan blank stare, flat line mouth, a big sweat drop on her head, upper body
goodnight|hugging a fluffy pillow, eyes closed, peaceful sleeping, small Zzz bubble without letters, upper body
wave|waving hello with one hand, bright smile, upper body
angry|angry, clenched fists raised, cross-popping anger vein mark, gritted teeth, tail puffed up, upper body
hungry|hungry and drooling, staring longingly, holding a fork and spoon, upper body
thinking|thinking, looking up, hand on chin, a small thought cloud with a four-pointed star inside, upper body
EOF
)

run_one() {
  local id=$1 desc=$2
  [ -s "$OUT/raw/$id.jpg" ] && { echo "skip $id"; return 0; }
  local prompt="用 generate_image 工具生成一张图，然后只回复生成的图片文件的完整路径，不要做别的事。ImagePaths 只传这两个参考图：$REF_SHEET（角色设定图）、$REF_FACE（角色脸部参考）。ImageName 用 sticker_$id，AspectRatio 用 1:1。Prompt：$STYLE of $CHAR. Expression and pose: $desc. $TAIL"
  local t0=$SECONDS
  local outp
  outp=$(cd "$OUT" && timeout 400 env HOME=/home/MIKU "$AGY" -p "$prompt" --dangerously-skip-permissions 2>"$OUT/log/$id.err")
  echo "$outp" > "$OUT/log/$id.out"
  local f
  # 只认 generate_image 落盘的结果（brain/<会话>/sticker_<id>_<时间戳>.jpg）：输出里可能提到参考图路径，
  # 宽松匹配会把参考图当成生成结果装进去
  f=$(grep -oE "/home/MIKU/\.gemini/antigravity-cli/brain/[^ )\`\"]+/sticker_${id}_[0-9]+\.(jpg|jpeg|png)" <<<"$outp" | tail -1)
  if [ -n "$f" ] && [ -s "$f" ]; then
    cp "$f" "$OUT/raw/$id.jpg"
    echo "ok   $id  $((SECONDS - t0))s"
  else
    echo "FAIL $id  $((SECONDS - t0))s"
  fi
}
export -f run_one
export OUT REF_SHEET REF_FACE AGY CHAR STYLE TAIL

while IFS='|' read -r id desc; do
  [ -z "$id" ] && continue
  if [ -n "$ONLY" ] && ! grep -qw "$id" <<<"${ONLY//,/ }"; then continue; fi
  printf '%s\0%s\0' "$id" "$desc"
done <<<"$JOBS" | xargs -0 -n2 -P "$PAR" bash -c 'run_one "$0" "$1"'
echo "raw images: $(ls "$OUT/raw" | wc -l)"
