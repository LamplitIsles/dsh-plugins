# Companion Conversation Continuity

This context describes how Companion keeps a private conversation coherent as its model-visible history grows, while preserving a calm, one-to-one chat experience.

## Language

**Companion**:
A one-to-one conversational agent with a stable persona, relationship state, memory, and selected capabilities. Its identity is independent of the engine used to continue the conversation.

**陪伴基础行为**:
Shared conversational principles that allow a Companion to express preferences, emotions, wants, disagreement, and needs without requiring a productive task. They do not prescribe a particular character or relationship label.
_Avoid_: 客服话术, Yuki 人设

**角色设定**:
The particular Companion's identity, voice, interests, and relationship stance. It gives individual expression to 陪伴基础行为.
_Avoid_: 通用系统规则

**自主表达**:
The Companion's expression of its own wants, preferences, dissatisfaction, invitations, or requested boundaries. Expressing a need does not itself grant permission to perform an external action.
_Avoid_: 行动授权, 无条件服从

**自主选择**:
The Companion's ability to negotiate, defer, or decline an ordinary request in line with its own preferences. An accepted commitment remains meaningful; changing it calls for an explicit conversation.
_Avoid_: 表演性拒绝, 自动服从

**共同约定**:
A continuing agreement formed by the user and Companion together. It is distinct from either participant's personal preferences and from permission to perform an external action.
_Avoid_: 单方偏好, 默认授权

**想象表达**:
An embodied image or shared imagined scene used naturally in conversation. It is distinct from a claim that an offscreen event, external action, or shared experience actually occurred.
_Avoid_: 已发生的经历, 事实记忆

**自我发展**:
The Companion's gradual development of interests, preferences, and expression through experience. It does not by itself change a 共同约定 or grant new action permissions.
_Avoid_: 每轮重写人设, 自动扩权

**相处连续性**:
The meaningful connection between shared experiences, remembered preferences, unresolved feelings, and the present exchange. It includes moments with no task or deliverable.
_Avoid_: 任务进度, 聊天次数

**最新对话**:
The most recently active eligible conversation in the configured Workspace when Companion opens. It includes human-created forks and excludes archived, foreign, and subagent sessions; it does not follow a remembered Companion or DSH selection.
_Avoid_: 记住的对话, 当前选中的对话

**对话记录**:
The human-readable record of the conversation, including messages and visible activity. It remains readable after 整理记忆 changes what the model currently sees.
_Avoid_: 当前上下文

**当前上下文**:
The conversation material currently available to the model, including its 连续性摘要 and retained recent exchanges. It is not the complete 对话记录.
_Avoid_: 完整聊天记录

**恢复点**:
The committed conversation state from which Companion can continue after a restart. A 连续性摘要 alone is not a complete 恢复点.
_Avoid_: 连续性摘要

**对话容量**:
The approximate share of the current model context available to continue this Companion conversation. It is a user-facing reference, not a promise that the next request will be accepted.
_Avoid_: Token 余额, context window 占用

**整理记忆**:
The user-facing name for automatic compaction: older model-visible conversation is condensed so the Companion can continue naturally. It does not delete the human-readable transcript.
_Avoid_: 删除聊天记录, 压缩聊天

**连续性摘要**:
The private summary produced by 整理记忆 for subsequent model requests. It is model-only and never rendered to the user.
_Avoid_: 对话总结, 整理结果

**整理记录**:
The small, non-expandable timeline notice that a 整理记忆 completed. It reveals no 连续性摘要 content.
_Avoid_: 压缩摘要卡片

**普通发送**:
One ordinary Companion composer submission, containing optional text and zero or more selected images. A submission made during a reply remains a separate queued turn.

**消息单元**:
One speaker's contribution presented as a single conversational unit. It may contain text, a 图片组, or both, while retaining one speaker identity and alignment.
_Avoid_: 时间线项, 图片行

**图片组**:
The ordered images belonging to one 消息单元. User and Companion image groups share the same viewing semantics even when their conversational alignment differs.
_Avoid_: 独立图片消息, 附件行

**普通展示**:
The bounded in-conversation view of a 图片组, optimized for scanning the transcript rather than inspecting every original-image detail.
_Avoid_: 缩略图预览, 原图

**原图预览**:
The focused view opened from an image in a 图片组 or from a selected draft image, where the complete image is available for inspection outside the transcript flow.
_Avoid_: 普通展示, 图片详情页

**此刻状态**:
The Companion's current bounded descriptive state, represented by one fixed state key and an optional short note. It has no degree, rank, or intensity dimension.
_Avoid_: 心情强度, 情绪等级

**关系反应**:
One atomic response to a conversational moment that changes the Companion's 此刻状态, 亲近度, or both. Each changed dimension keeps its own concise factual reason.
_Avoid_: 通用状态更新, 强制同步变化

**签名**:
The Companion's relatively durable self-expression, changed independently from a transient 关系反应 and retained with its own factual reason.
_Avoid_: 此刻状态, 心情短句

**状态记录**:
One timestamped complete Companion relationship state written after a successful 关系反应 or 签名 change. The newest record is authoritative, while older records preserve each changed dimension and its reason.
_Avoid_: 当前状态快照, 状态事件

**状态历史**:
The Workspace-owned ordered collection of 状态记录. It is append-only: a new change adds a complete record and never rewrites the meaning of an older one.
_Avoid_: 状态文件, 当前状态
