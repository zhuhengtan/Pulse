# Persistent scheduled tasks

Scheduled tasks currently use the CLI. They do not appear in the Web/Desktop settings UI. Creating a task does not start a worker or install an operating-system service.

## Create and manage

```sh
# Existing fixed elapsed-time interval
pulse schedule add --every 1h --name "Project check" "Check the project"
# One specific local date and minute
pulse schedule add --at 2027-01-20T10:00 --timezone Asia/Shanghai "Prepare today's brief"
# Same wall clock each day
pulse schedule add --daily 09:00 --timezone America/New_York "Review project status"
# Monday and Wednesday, in the selected zone
pulse schedule add --weekly mon,wed --time 10:00 --timezone Europe/London "Review open work"
# Explicitly allow one catch-up after downtime
pulse schedule add --daily 09:00 --timezone Asia/Shanghai --missed-run run-once "Check status"
pulse schedule list
pulse schedule pause <task-id>
pulse schedule resume <task-id>
pulse schedule remove <task-id>
```

Choose exactly one of `--every`, `--at`, `--daily`, and `--weekly`. Calendar schedules require an explicit IANA timezone (or UTC); the computer's timezone does not change the plan. Times use 24-hour HH:mm. Weekdays are sun,mon,tue,wed,thu,fri,sat. A past or nonexistent one-shot date/time is rejected. Changing a schedule requires pausing/removing it and creating a new one; pausing an active task does not cancel its current execution.

`list` includes the schedule, nextRunAt (UTC Unix milliseconds), pause/completion state, lastRun, and lastSkipped. For completed one-shot tasks, nextRunAt is the original consumed date, not another pending run. Records are private files in the configured data directory (`scheduled-tasks.json`). Existing interval-only records remain readable. Older binaries do not understand new calendar fields and fail closed: do not share the store with an older worker or downgrade without a backup.

## Worker and restart

```sh
pulse --read-only schedule daemon
pulse --read-only schedule run-once
pulse service status
```

The daemon polls while running. `run-once` executes at most one currently due task. Both need read-only or explicitly configured auto approval; schedule creation does not grant permission to execute tools. Each task keeps the workspace where it was created. No model/provider calls occur just to calculate a schedule.

The durable store is reopened when the worker starts, so pending schedules survive worker exits and computer restarts. To start automatically after login, the existing `pulse service install` command installs and starts a per-user service (macOS LaunchAgent, Linux user systemd, Windows login task). **Installing that service changes OS startup configuration and must be explicitly approved. It is not performed by adding a schedule.** `pulse service stop` stops the worker; `pulse service uninstall` removes its startup configuration, preserving task data. The service does not wake a sleeping or powered-off computer. Without an installed service, restart the daemon manually after login. Merely opening the Desktop app does not start this CLI worker.

## Missed runs and daylight saving

- Calendar schedules default to `--missed-run skip`: an occurrence more than 60 seconds late is skipped. A current occurrence inside that grace window can still run after older dates are skipped. `lastSkipped` records the first skipped pending occurrence and the time it was skipped. A missed one-shot is marked completed without execution.
- `--missed-run run-once` explicitly permits one catch-up when the worker returns. It never queues every missed date. Recurring tasks then resume at the next future wall-clock occurrence.
- Existing `--every` intervals retain their behavior: one overdue execution, then advance to the next interval. Calendar-only flags cannot be combined with `--every`.
- Spring-forward nonexistent minutes are skipped for recurring tasks; one-shot times in that gap are rejected. During fall-back repeated minutes, only the earlier instant runs. Non-hour DST changes and civil-date skips follow the same rule.
- Tasks are serialized across all workers sharing the same local data directory. A long-running task can make later occurrences miss the grace window; choose catch-up explicitly if needed. There is no concurrent backlog replay.
- This is a local scheduler. Network/provider outages after execution starts are recorded as failures; failure does not implicitly authorize retries. Suspend, offline time, and worker downtime follow the missed-run policy when the worker returns.

## Failure and duplicate safety

Claims and next occurrences are atomically persisted under a cross-process file lock before execution begins. One-shot tasks are consumed when claimed. Success, failure, or interruption never automatically retries that same occurrence, so a crash after external side effects cannot silently duplicate them. This favors at-most-once admission over guaranteed delivery; an interrupted task may have done partial work and needs review before explicitly scheduling another run. It is not an exactly-once guarantee for external services.

A living owner retains its claim even after lease expiry. A changed macOS/Linux boot identity proves the old process stopped, including when its PID has been reused. If the OS boot identity is unavailable (including the current Windows fallback), or an older claim has no boot identity and its PID appears alive, recovery fails closed until the ambiguity is resolved. Otherwise a dead owner is recorded as interrupted, and future recurring occurrences remain scheduled. This does not install or alter system settings.

If cancellation cannot confirm all side effects stopped, the claim is quarantined and blocks further work. Stop the worker and child processes, verify their side effects, then explicitly run:

```sh
pulse schedule recover <task-id> --confirm-stopped
```

Do not use recovery as a way to retry work with an uncertain outcome. It releases a confirmed-stopped quarantined claim; the consumed occurrence is not retried.
