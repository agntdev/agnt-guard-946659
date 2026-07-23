# GroupGuard — Bot specification

**Archetype:** community

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

Automated moderation bot for Telegram groups that enforces human verification on joins, detects spam, provides admin controls, and maintains action logs and stats. Protects against spam while giving admins tools to manage members and view moderation summaries.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- Telegram group owners
- Telegram admins

## Success criteria

- Reduces spam incidents by 80% within first month
- Maintains 95% user verification rate
- Provides admins with actionable moderation stats weekly

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Open the main menu
- **I'm human** (button, actor: user, callback: verification:confirm) — Verify new member identity to gain message privileges
  - inputs: user_id, join_time
  - outputs: trusted_flag, message_privileges
- **/mod** (command, actor: admin, command: /mod) — Open admin moderation panel
- **Warn** (button, actor: admin, callback: admin:warn) — Issue warning to member
  - inputs: target_user_id, reason
  - outputs: infraction_record
- **Mute** (button, actor: admin, callback: admin:mute) — Mute member for configured duration
  - inputs: target_user_id, duration
  - outputs: infraction_record
- **Kick** (button, actor: admin, callback: admin:kick) — Remove member from group
  - inputs: target_user_id, reason
  - outputs: infraction_record
- **Ban** (button, actor: admin, callback: admin:ban) — Permanently ban member
  - inputs: target_user_id, reason
  - outputs: infraction_record
- **Mark Trusted** (button, actor: admin, callback: admin:trust) — Mark user as trusted to exempt from auto-moderation
  - inputs: target_user_id
  - outputs: trusted_flag
- **View Stats** (button, actor: admin, callback: admin:stats) — Show moderation statistics and logs
  - inputs: timeframe
  - outputs: audit_log_summary

## Flows

### New Member Verification
_Trigger:_ user joins group

1. Post welcome message with rules and verification button
2. Restrict message privileges
3. Wait for verification button press or timeout
4. If verified within 30s: grant privileges and log verification
5. If timeout: remove member and post explanation

_Data touched:_ Member, Verification challenge, Infraction

### Spam Detection
_Trigger:_ message posted

1. Check if sender is admin/trusted
2. If not, analyze message for spam patterns
3. If spam detected: apply configured action (warn/mute/kick/ban)
4. Post explanation message
5. Log infraction

_Data touched:_ Member, Infraction, Audit log

### Admin Moderation
_Trigger:_ /mod command or admin button press

1. Show moderation panel with available actions
2. Execute selected action (warn/mute/kick/ban/trust)
3. Update member status
4. Log action in audit log
5. Post notification if configured

_Data touched:_ Member, Infraction, Audit log

### Configuration Management
_Trigger:_ admin command or button press

1. Show configuration options
2. Update welcome text, rules, or thresholds
3. Save changes to persistent storage
4. Confirm update

_Data touched:_ Member, Audit log

### Stats Reporting
_Trigger:_ admin request or scheduled interval

1. Aggregate recent audit log data
2. Format summary of joins, verifications, removals
3. Send to configured admin target
4. Confirm delivery

_Data touched:_ Audit log

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

- **Member** _(retention: persistent)_ — User in the group with metadata
  - fields: user_id, join_time, trusted_flag, admin_flag, infraction_history
- **Verification challenge** _(retention: session)_ — One-time verification prompt for new members
  - fields: user_id, timestamp, status
- **Infraction** _(retention: persistent)_ — Moderation action record
  - fields: actor, target, action, reason, timestamp
- **Audit log** _(retention: persistent)_ — Recent moderation actions
  - fields: action, target, actor, timestamp, reason

## Integrations

- **Telegram** (required) — Bot API messaging and moderation actions
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Configure welcome text and rules
- Set spam thresholds and enabled actions
- Designate trusted users
- Change notification target for summaries
- View audit logs and stats

## Notifications

- In-group automated explanations for bot actions
- Daily/weekly summary reports to admin target

## Permissions & privacy

- Only group admins can access moderation controls
- Audit logs retain last 200 actions for privacy
- Trusted user status is manually set by admins
- Admins can view only their own group's data

## Edge cases

- User joins during verification timeout window
- Admin sends message that matches spam pattern
- Multiple spam triggers in quick succession
- Verification button pressed after timeout but before removal

## Required tests

- Verify new member verification flow with timeout
- Test spam detection thresholds with various patterns
- Confirm admin commands work without affecting admins
- Validate audit log retention and pruning
- Test notification delivery to admin target

## Assumptions

- Admins will configure thresholds appropriately for their group
- Trusted users are manually vetted by admins
- Group owner will set up notification target correctly
- Spam patterns will evolve and may require threshold adjustments
