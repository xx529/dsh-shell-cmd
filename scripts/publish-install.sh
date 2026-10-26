#!/usr/bin/env bash
#
# dsh-shell-cmd · 推送仓库 + 从 GitHub 仓库重新安装到当前 DSH profile
#
# 做的事：
#   1. （可选）提交当前工作区改动
#   2. （可选）git push 到 origin
#   3. 用当前 commit 的 GitHub 归档（默认 tarball）安装到 profile：
#      dsh plugin --profile <name> add <spec>
#      —— dsh CLI 会跑 pnpm，并把声明了 dsh.bundle 的包自动加入 dsh.profile.bundles
#   4. 校验 profile 的依赖 spec、bundle 列表、已安装版本与运行时文件
#
# 常用：
#   scripts/publish-install.sh                     # 提交 + 推送 + 安装 + 校验
#   scripts/publish-install.sh --dry-run           # 只打印计划，不执行
#   scripts/publish-install.sh --no-push           # 不推送（commit 必须已在远端）
#   scripts/publish-install.sh --profile web       # 指定 profile（默认 $DSH_PROFILE 或 desktop）
#   scripts/publish-install.sh --mode git          # 用 github:owner/repo#sha 代替 tarball
#   scripts/publish-install.sh --spec <raw-spec>   # 完全自定义安装 spec
#
# 私有仓库 / 受限网络：--spec 可传 git+https 或带凭据的 URL；默认 tarball 走
# https://codeload.github.com/<owner>/<repo>/tar.gz/<sha>（匿名可读的公开仓库）。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROFILE="${DSH_PROFILE:-desktop}"
PUSH=1
DO_COMMIT=1
DRY_RUN=0
MODE="tarball"
SPEC_OVERRIDE="${DSH_PLUGIN_SPEC:-}"
MESSAGE=""
REMOTE="origin"

die() {
  printf 'publish-install: error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*" >&2
}

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '+ %s\n' "$*"
    return 0
  fi
  "$@"
}

usage() {
  cat <<'EOF'
用法: scripts/publish-install.sh [选项]

选项:
  --profile <name>   目标 DSH profile（默认取 ${DSH_PROFILE}，否则 desktop）
  --message <msg>    提交信息（默认 "chore: update dsh-shell-cmd <version>"）
  --mode tarball|git 安装源形式（默认 tarball：GitHub 归档 URL；git：github:owner/repo#sha）
  --spec <spec>      完全自定义交给 dsh plugin add 的安装 spec（覆盖 --mode）
  --remote <name>    git remote 名（默认 origin）
  --no-push          跳过 git push（要求 HEAD 已经在远端，否则安装会 404）
  --no-commit        不自动提交；要求工作区干净
  --dry-run          只打印将要执行的命令，不做任何修改
  -h, --help         显示本帮助

环境变量:
  DSH_PROFILE / DSH_PROFILE_DIR / DSH_HOME   由 dsh 注入；脚本也会使用它们
  DSH_PLUGIN_SPEC                            等价于 --spec

示例:
  scripts/publish-install.sh
  scripts/publish-install.sh --dry-run
  scripts/publish-install.sh --no-commit --no-push --spec github:xx529/dsh-shell-cmd#<sha>
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      [ $# -ge 2 ] || die "--profile 需要一个参数"
      PROFILE="$2"
      shift 2
      ;;
    --message)
      [ $# -ge 2 ] || die "--message 需要一个参数"
      MESSAGE="$2"
      shift 2
      ;;
    --mode)
      [ $# -ge 2 ] || die "--mode 需要一个参数"
      MODE="$2"
      shift 2
      ;;
    --spec)
      [ $# -ge 2 ] || die "--spec 需要一个参数"
      SPEC_OVERRIDE="$2"
      shift 2
      ;;
    --remote)
      [ $# -ge 2 ] || die "--remote 需要一个参数"
      REMOTE="$2"
      shift 2
      ;;
    --no-push)
      PUSH=0
      shift
      ;;
    --no-commit)
      DO_COMMIT=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "未知参数: $1（用 --help 查看用法）"
      ;;
  esac
done

# ---------------------------------------------------------------------------
# 前置检查
# ---------------------------------------------------------------------------

case "$PROFILE" in
  *[!A-Za-z0-9._-]*) die "非法的 profile 名: $PROFILE" ;;
esac

case "$MODE" in
  tarball | git) ;;
  *) die "--mode 只支持 tarball 或 git" ;;
esac

command -v git >/dev/null 2>&1 || die "未找到 git"
git rev-parse --git-dir >/dev/null 2>&1 || die "当前目录不是 git 仓库: $REPO_ROOT"

[ -f "$REPO_ROOT/package.json" ] || die "缺少 package.json"
NAME="$(node -p "require('$REPO_ROOT/package.json').name")"
VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
[ -n "$NAME" ] || die "无法从 package.json 读取 name"

REMOTE_URL="$(git remote get-url "$REMOTE" 2>/dev/null)" || die "未配置 git remote '$REMOTE'"
OWNER_REPO="$(printf '%s' "$REMOTE_URL" |
  sed -E 's#^git@github\.com:##; s#^git\+ssh://git@github\.com/##; s#^ssh://git@github\.com/##; s#^https?://github\.com/##; s#\.git$##')"
case "$OWNER_REPO" in
  */*) ;;
  *) die "无法从 remote 解析 owner/repo: ${REMOTE_URL}（可用 --spec 指定安装源）" ;;
esac
OWNER="${OWNER_REPO%%/*}"
REPO_NAME="${OWNER_REPO#*/}"
[ -n "$OWNER" ] && [ -n "$REPO_NAME" ] || die "无法从 remote 解析 owner/repo: $REMOTE_URL"

BRANCH="$(git symbolic-ref --quiet --short HEAD)" || die "HEAD 处于 detached 状态，请先切到分支"

# ---------------------------------------------------------------------------
# 1. 提交
# ---------------------------------------------------------------------------

if [ -n "$(git status --porcelain)" ]; then
  if [ "$DO_COMMIT" = 1 ]; then
    COMMIT_MSG="${MESSAGE:-chore: update $NAME $VERSION}"
    note "提交工作区改动: $COMMIT_MSG"
    run git add -A
    run git commit -m "$COMMIT_MSG"
  else
    die "工作区有未提交改动；先提交，或去掉 --no-commit"
  fi
else
  note "工作区干净，无需提交"
fi

if [ "$DRY_RUN" = 1 ]; then
  # dry-run 不提交，就无法得到“将要提交后”的 SHA；按当前 HEAD 继续演示。
  note "（dry-run：上面列出的提交不会执行，下面的 SHA 取当前 HEAD）"
fi

# ---------------------------------------------------------------------------
# 2. 推送
# ---------------------------------------------------------------------------

if [ "$PUSH" = 1 ]; then
  note "推送到 ${REMOTE}（${BRANCH}）..."
  run git push -u "$REMOTE" HEAD
else
  note "跳过 git push（--no-push）"
fi

SHA="$(git rev-parse HEAD)"
SHORT_SHA="$(printf '%s' "$SHA" | cut -c1-12)"

# ---------------------------------------------------------------------------
# 3. 组装安装 spec
# ---------------------------------------------------------------------------

if [ -n "$SPEC_OVERRIDE" ]; then
  SPEC="$SPEC_OVERRIDE"
elif [ "$MODE" = "git" ]; then
  SPEC="github:$OWNER/$REPO_NAME#$SHA"
else
  SPEC="https://codeload.github.com/$OWNER/$REPO_NAME/tar.gz/$SHA"
fi

if [ "$PUSH" = 0 ] && [ -z "$SPEC_OVERRIDE" ]; then
  note "警告: 跳过了 push，但安装 spec 指向 commit ${SHORT_SHA}；该 commit 必须已经存在于远端，否则 pnpm 会拉取失败"
fi

command -v dsh >/dev/null 2>&1 ||
  die "未找到 dsh CLI；它是安装 bundle 并回写 profile 的必要工具（npm i -g @deepseek-ai/dsh）"

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
if [ "$PROFILE" = "${DSH_PROFILE:-}" ] && [ -n "${DSH_PROFILE_DIR:-}" ]; then
  PROFILE_DIR="$DSH_PROFILE_DIR"
else
  PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
fi

note ""
note "package : $NAME@$VERSION"
note "commit  : $SHA"
note "profile : $PROFILE ($PROFILE_DIR)"
note "install : $SPEC"
note ""

# ---------------------------------------------------------------------------
# 4. 安装
# ---------------------------------------------------------------------------

run dsh plugin --profile "$PROFILE" add "$SPEC"

if [ "$DRY_RUN" = 1 ]; then
  note ""
  note "(dry-run) 实际安装与校验已跳过"
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. 校验
# ---------------------------------------------------------------------------

note ""
PROFILE_DIR="$PROFILE_DIR" PKG_NAME="$NAME" PKG_VERSION="$VERSION" PKG_SPEC="$SPEC" node - <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const profileDir = process.env.PROFILE_DIR
const name = process.env.PKG_NAME
const version = process.env.PKG_VERSION
const spec = process.env.PKG_SPEC
const problems = []

const manifestPath = path.join(profileDir, 'package.json')
if (!fs.existsSync(manifestPath)) {
  console.error(`publish-install: 未找到 profile manifest: ${manifestPath}`)
  process.exit(2)
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const dependency = manifest.dependencies?.[name]
const bundles = manifest.dsh?.profile?.bundles ?? []
const packageDir = path.join(profileDir, 'node_modules', name)
const installedManifestPath = path.join(packageDir, 'package.json')

if (dependency !== spec) {
  problems.push(`dependencies["${name}"] = ${JSON.stringify(dependency)}，期望 ${JSON.stringify(spec)}`)
}
if (!bundles.includes(name)) {
  problems.push(`dsh.profile.bundles 未包含 ${name}`)
}
if (!fs.existsSync(installedManifestPath)) {
  problems.push(`未安装: ${installedManifestPath}`)
}

let installedVersion = null
if (fs.existsSync(installedManifestPath)) {
  const installed = JSON.parse(fs.readFileSync(installedManifestPath, 'utf8'))
  installedVersion = installed.version
  if (installed.version !== version) {
    problems.push(`已安装版本 ${installed.version} ≠ 仓库版本 ${version}`)
  }
  if (installed.dsh?.bundle?.patch !== './cordis.patch.yml') {
    problems.push(`安装包的 dsh.bundle.patch 声明异常: ${JSON.stringify(installed.dsh?.bundle?.patch)}`)
  }
  if (installed.dsh?.client === undefined) {
    problems.push('安装包缺少 dsh.client 声明（浏览器半端不会加载）')
  }
  for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg']) {
    if (!fs.existsSync(path.join(packageDir, file))) {
      problems.push(`安装包缺少运行时文件: ${file}（检查 package.json 的 files）`)
    }
  }
}

if (problems.length > 0) {
  console.error('publish-install: 安装校验失败:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(2)
}

console.log(`publish-install: 校验通过 ${name}@${installedVersion}`)
console.log(`  dependency : ${dependency}`)
console.log(`  bundles    : 已包含 ${name}`)
console.log(`  安装目录   : ${packageDir}`)
NODE

note ""
note "完成。让新版本生效："
note "  1) 在 设置 → 插件 里拨动 $NAME 的开关，或重启 DSH；"
note "  2) 只改了 client.js 时，刷新页面即可。"
note ""
note "开发迭代仍可用本地链接安装（plugin_manager install_bundle 指向工作区）；"
note "两者二选一：再次运行本脚本会把 link: 换成仓库 spec。"
