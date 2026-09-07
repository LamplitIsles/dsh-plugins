# dsh-mail

The plugin gives an Agent ownership of one email address while preventing it from accessing any other mailbox exposed by the email provider.

## Language

**Agent mailbox**:
The single email address assigned to an Agent. The Agent may read mail in this mailbox and send or reply using this address without recipient allowlists, draft-only restrictions, or per-message approval.
_Avoid_: selected mailbox, arbitrary mailbox

**Mailbox isolation**:
The rule that every email operation is limited to the Agent mailbox. The Agent cannot enumerate, read, modify, or send as any other mailbox, even if the underlying email provider can serve them.

**Upstream mailbox MCP**:
The external MCP service that stores and sends email. It is not relied upon to enforce Mailbox isolation.
