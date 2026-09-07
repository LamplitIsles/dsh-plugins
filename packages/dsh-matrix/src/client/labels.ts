/** Browser-safe default copy shared by the locale registration and settings card. */
export type MatrixLocaleKey =
  | "title" | "description" | "homeserverUrl" | "homeserverHint" | "userId" | "userIdHint"
  | "roomId" | "roomIdHint" | "workspaceId" | "workspaceHint" | "workspaceMissing" | "accessToken"
  | "accessTokenHint" | "configured" | "notConfigured" | "respondToAll" | "respondToAllHint" | "runtime"
  | "restartHint" | "unbound" | "save" | "saving" | "discard" | "unsaved" | "readOnly" | "saveFailed"
  | "required" | "invalidUrl" | "missingSettings" | "missingCredential" | "connecting" | "bound" | "failed" | "disabled";

export const matrixLabels: Record<MatrixLocaleKey, string> = {
  title: "Matrix companion",
  description: "Connect one Matrix room to an existing Companion conversation.",
  homeserverUrl: "Homeserver URL",
  homeserverHint: "The homeserver/API URL used by Element, for example https://matrix.example.com. It may differ from the domain in the Matrix user ID.",
  userId: "Matrix user ID",
  userIdHint: "Enter the complete ID, for example @bot:matrix.example.com, not only bot.",
  roomId: "Allowed room ID",
  roomIdHint: "Enter the complete room ID, for example !abcdef:matrix.example.com, not a #room:example.com alias.",
  workspaceId: "Companion workspace",
  workspaceHint: "The workspace whose active conversation is locked at startup.",
  workspaceMissing: "The selected workspace is not available in this DSH deployment.",
  accessToken: "Element access token",
  accessTokenHint: "Use an Element access token belonging to the Matrix user above. It is write-only; leave blank to keep the current token.",
  configured: "Configured",
  notConfigured: "Not configured",
  respondToAll: "Respond to all messages",
  respondToAllHint: "Off means the bot requires a mention or a reply to its message.",
  runtime: "Runtime readiness",
  restartHint: "Changes apply after restarting DSH; the bound conversation never switches live.",
  unbound: "Connected, but no eligible existing Companion conversation was found.",
  save: "Save",
  saving: "Saving…",
  discard: "Discard",
  unsaved: "Unsaved",
  readOnly: "This deployment is read-only.",
  saveFailed: "The deployment rejected these values; your draft was kept.",
  required: "Required",
  invalidUrl: "Enter a valid http(s) URL.",
  missingSettings: "Incomplete settings",
  missingCredential: "Access token is not configured.",
  connecting: "Connecting…",
  bound: "Bound to an existing conversation",
  failed: "Connection unavailable",
  disabled: "Stopped"
};

export const matrixZhLabels: Record<MatrixLocaleKey, string> = {
  title: "Matrix companion",
  description: "将一个 Matrix 房间连接到现有的 Companion 会话。",
  homeserverUrl: "Homeserver URL",
  homeserverHint: "填写 Element 实际连接的 homeserver/API 地址，例如 https://matrix.example.com；它可以与 Matrix 用户 ID 的域名不同。",
  userId: "Matrix 用户 ID",
  userIdHint: "填写完整 ID，例如 @bot:matrix.example.com，而不是只填 bot。",
  roomId: "允许的房间 ID",
  roomIdHint: "填写完整 room ID，例如 !abcdef:matrix.example.com；不要填写 #room:example.com 房间别名。",
  workspaceId: "Companion Workspace",
  workspaceHint: "插件启动时会固定绑定这个 Workspace 中最近活跃的现有会话。",
  workspaceMissing: "当前 DSH 中找不到之前选择的 Workspace，请重新选择。",
  accessToken: "Element access token",
  accessTokenHint: "填写属于上述 Matrix 用户的 Element access token。该字段只写；留空会保留现有 token。",
  configured: "已配置",
  notConfigured: "未配置",
  respondToAll: "响应所有消息",
  respondToAllHint: "关闭时，只有 @mention bot 或回复 bot 的消息才会触发。",
  runtime: "运行状态",
  restartHint: "修改后需重启 DSH；运行期间不会切换已绑定的会话。",
  unbound: "Matrix 已连接，但所选 Workspace 中没有可绑定的现有 Companion 会话。",
  save: "保存",
  saving: "正在保存…",
  discard: "放弃修改",
  unsaved: "未保存",
  readOnly: "当前部署为只读，无法保存设置。",
  saveFailed: "部署未接受这些值；草稿已保留。",
  required: "必填",
  invalidUrl: "请输入有效的 http(s) URL。",
  missingSettings: "设置不完整",
  missingCredential: "尚未配置 access token。",
  connecting: "正在连接…",
  bound: "已绑定现有会话",
  failed: "连接不可用",
  disabled: "已停止"
};

export const matrixLocale = { en: matrixLabels, zh: matrixZhLabels } as const;
