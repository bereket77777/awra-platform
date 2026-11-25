import { useEffect, useRef, useState } from "react";

function ProfileIcon() {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10.25" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="12" cy="9.25" r="3.1" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M5.75 18.25c1.25-2.55 3.55-3.9 6.25-3.9s5 1.35 6.25 3.9"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PracticeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path d="M8 5a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0V5Z" stroke="currentColor" strokeWidth="1.25" />
      <path d="M5 10.5a7 7 0 0 0 14 0M12 17.5V21m-3 0h6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function ActivityIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path d="M4 19V5m0 14h16M7 15l4-4 3 2 5-6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path d="m5 7 1.5 1.5L9 6m3 1h7M5 14l1.5 1.5L9 13m3 1h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrophyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path d="M8 4h8v4.5a4 4 0 0 1-8 0V4Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
      <path d="M8 6H5v2a3 3 0 0 0 3 3M16 6h3v2a3 3 0 0 1-3 3M12 12.5V17m-3 3h6m-5-3h4m-5 3v-3h6v3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function AwraBigLogo() {
  return (
    <svg className="awra-big-logo" viewBox="0 0 320 120" fill="none" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeLinecap="round">
        <path d="M12 55v36m296-36v36M18 111h284" strokeWidth="0.8" opacity="0.22" />
        <path d="M23 104h274" strokeWidth="0.6" opacity="0.18" />
      </g>
      <g fill="currentColor">
        <path d="M20 101 44 40h15L42 101Z" />
        <path d="M51 40h15l25 61H73Z" />
        <path d="m38 78 36 0 7 12-49 0Z" />
        <path d="m29 39 5-21 9 10 8-17 8 17 9-10 5 21Z" />
        <g transform="translate(220 0)">
          <path d="M20 101 44 40h15L42 101Z" />
          <path d="M51 40h15l25 61H73Z" />
          <path d="m38 78 36 0 7 12-49 0Z" />
        </g>
      </g>
      <g fill="none" stroke="currentColor" strokeLinecap="square" strokeLinejoin="miter">
        <path d="m101 49 12 52 18-34 18 34 12-52" strokeWidth="11" />
        <path d="M177 51h20c18 0 18 25 0 25h-20v25m19-25 23 25" strokeWidth="11" />
      </g>
    </svg>
  );
}

function getEmptyActivityWeek() {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - index));
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { date: dateKey, minutes: 0 };
  });
}

function getWeekdayLabel(date) {
  const parsedDate = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsedDate.getTime())
    ? ""
    : parsedDate.toLocaleDateString(undefined, { weekday: "short" });
}

function ActivityGraph({ data }) {
  const max = Math.max(...data.map((day) => Number(day.minutes) || 0), 1);

  return (
    <div className="awra-activity__graph" aria-label="Practice time over the last seven days">
      {data.map((day) => {
        const minutes = Number(day.minutes) || 0;
        return (
          <div className="awra-activity__column" key={day.date}>
            <span className="awra-activity__value">{minutes}</span>
            <span
              className="awra-activity__bar"
              style={{ height: `${minutes === 0 ? 2 : Math.max((minutes / max) * 100, 8)}%` }}
            />
            <span className="awra-activity__day">{getWeekdayLabel(day.date)}</span>
          </div>
        );
      })}
    </div>
  );
}

function ActivityView({ activitySummary, user, profile }) {
  const displayName = profile?.display_name || user?.user_metadata?.display_name || "student";
  const activity = activitySummary?.activity ?? {};
  const streak = activitySummary?.streak ?? {};
  const currentStreak = streak.current_days ?? profile?.current_streak_days ?? 0;
  const longestStreak = streak.longest_days ?? profile?.longest_streak_days ?? 0;
  const rankTier = streak.rank_tier ?? profile?.rank_tier ?? "—";
  const graphData =
    Array.isArray(activity.last_7_days) && activity.last_7_days.length > 0
      ? activity.last_7_days
      : getEmptyActivityWeek();
  const summaryCards = [
    ["Today", activity.today_minutes ?? 0, "min"],
    ["This Week", activity.this_week_minutes ?? 0, "min"],
    ["This Month", activity.this_month_minutes ?? 0, "min"],
    ["Current streak", currentStreak, "days"],
    ["Longest streak", longestStreak, "days"],
    ["Rank", rankTier, ""],
  ];

  return (
    <section
      className="awra-content-view awra-activity-view"
      aria-label={`Practice activity for ${displayName}, current streak ${currentStreak} days, longest streak ${longestStreak} days, rank ${rankTier}`}
    >
      <div className="awra-content-view__heading">
        <h2>Activity</h2>
        <p>Speaking time</p>
      </div>
      <div className="awra-activity__summary">
        {summaryCards.map(([label, value, unit]) => (
          <article className="awra-activity__summary-card" key={label}>
            <span>{label}</span>
            <strong>{value} {unit && <small>{unit}</small>}</strong>
          </article>
        ))}
      </div>
      <section className="awra-activity__chart-card" aria-label="Last seven days">
        <div className="awra-activity__chart-heading">
          <h3>Last 7 days</h3>
          <span>Minutes</span>
        </div>
        <ActivityGraph data={graphData} />
      </section>
    </section>
  );
}

function TasksView({
  tasks,
  tasksLoading,
  taskTitle,
  onTaskTitleChange,
  onAddTask,
  taskSubmitting,
  taskError,
  pendingTaskIds,
  onToggleTask,
  onDeleteTask,
  user,
  profile,
}) {
  const displayName = profile?.display_name || user?.user_metadata?.display_name || "student";
  const isSignedIn = Boolean(user?.id);
  const completedCount = tasks.filter((task) => task.is_completed).length;

  return (
    <section
      className="awra-content-view awra-tasks-view"
      aria-label={isSignedIn ? `Speaking tasks for ${displayName}` : "Speaking tasks"}
    >
      <div className="awra-content-view__heading">
        <div>
          <h2>Tasks</h2>
          <p>{completedCount} / {tasks.length} completed</p>
        </div>
      </div>
      <form className="awra-task-form" onSubmit={onAddTask}>
        <label className="sr-only" htmlFor="awra-task-title">New task</label>
        <input
          id="awra-task-title"
          type="text"
          value={taskTitle}
          maxLength={160}
          placeholder="Add a speaking goal"
          onChange={(event) => onTaskTitleChange(event.target.value)}
          disabled={!isSignedIn || taskSubmitting}
        />
        <button type="submit" disabled={!isSignedIn || taskSubmitting || !taskTitle.trim()}>
          {taskSubmitting ? "Adding…" : "Add"}
        </button>
      </form>
      {taskError && <p className="awra-inline-error" role="alert">{taskError}</p>}
      {tasksLoading ? (
        <p className="awra-empty-state" role="status">Loading tasks…</p>
      ) : tasks.length === 0 ? (
        <p className="awra-empty-state">No tasks yet. Add a speaking goal to get started.</p>
      ) : (
      <ul className="awra-task-list">
        {tasks.map((task) => (
          <li className="awra-task-list__item" key={task.id}>
            <button
              type="button"
              className={`awra-task ${task.is_completed ? "is-complete" : ""}`}
              onClick={() => onToggleTask?.(task.id)}
              aria-pressed={task.is_completed}
              disabled={pendingTaskIds.includes(task.id)}
            >
              <span className="awra-task__check" aria-hidden="true">
                {task.is_completed ? "✓" : ""}
              </span>
              <span className="awra-task__copy">
                <span>{task.title}</span>
                {task.notes && <small>{task.notes}</small>}
              </span>
            </button>
            <button
              type="button"
              className="awra-task__delete"
              onClick={() => onDeleteTask?.(task.id)}
              disabled={pendingTaskIds.includes(task.id)}
              aria-label={`Delete ${task.title}`}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      )}
    </section>
  );
}

export default function PracticeScreen({
  user = null,
  profile = null,
  displayName = "Speaker",
  onSignOut,
  onPractice,
  subtitle = "Find a partner for a ten-minute speaking session.",
  activitySummary = null,
  notifications = [],
  unreadCount = 0,
  notificationError = "",
  notificationPendingIds = [],
  onMarkNotificationRead,
  onMarkAllNotificationsRead,
  tasks = [],
  tasksLoading = false,
  taskTitle = "",
  onTaskTitleChange,
  onAddTask,
  taskSubmitting = false,
  taskError = "",
  pendingTaskIds = [],
  onToggleTask,
  onDeleteTask,
}) {
  const [profileOpen, setProfileOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("practice");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const profileRef = useRef(null);
  const accountName = profile?.display_name || displayName;
  const rankTier = activitySummary?.streak?.rank_tier ?? profile?.rank_tier ?? "—";

  useEffect(() => {
    function handlePointerDown(event) {
      if (profileRef.current && !profileRef.current.contains(event.target)) {
        setProfileOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setProfileOpen(false);
        setNotificationsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <div className="awra-screen">
      <header className="awra-topbar">
        <h1 className="awra-brand">AWRA</h1>
        <div className="awra-topbar__utilities">
          {/* TODO: Re-enable guest flow: restore VIP and position badges in the dashboard header.
          <div className="awra-topbar__badges">
            {vip && <span className="awra-badge awra-badge--vip">VIP</span>}
            {badge && <span className="awra-badge awra-badge--position">{badge}</span>}
          </div>
          */}
          <button
            type="button"
            className="awra-notifications"
            onClick={() => setNotificationsOpen((open) => !open)}
            aria-label={`Notifications, ${unreadCount} unread`}
            aria-expanded={notificationsOpen}
          >
            <BellIcon />
            {unreadCount > 0 && (
              <span className="awra-notifications__count" aria-hidden="true">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>
          <div className="awra-status-pill" role="group" aria-label={`Practice rank ${rankTier}`}>
            <TrophyIcon />
            <span>{rankTier}</span>
          </div>
        </div>
      </header>

      <main className="awra-practice">
        {notificationsOpen ? (
          <section className="awra-content-view awra-notification-view" aria-label="Notifications">
            <div className="awra-content-view__heading">
              <h2>Notifications</h2>
              <div className="awra-notification-actions">
              <button
                type="button"
                className="awra-text-button"
                onClick={onMarkAllNotificationsRead}
                disabled={unreadCount === 0 || notificationPendingIds.length > 0}
              >
                Mark all read
              </button>
              <button
                type="button"
                className="awra-text-button"
                onClick={() => setNotificationsOpen(false)}
              >
                Done
              </button>
              </div>
            </div>
            {notificationError && <p className="awra-inline-error" role="alert">{notificationError}</p>}
            {notifications.length === 0 ? (
              <p className="awra-empty-state">You’re all caught up.</p>
            ) : (
              <ul className="awra-notification-list">
                {notifications.map((notification) => (
                  <li
                    className={`awra-notification awra-notification--${notification.kind} ${notification.read_at ? "is-read" : "is-unread"}`}
                    key={notification.id}
                  >
                    <div>
                      <span className="awra-notification__kind">
                        {notification.kind === "appreciation"
                          ? "Appreciation"
                          : notification.kind === "milestone"
                            ? "Milestone"
                            : notification.kind === "warning"
                              ? "Warning"
                              : "Update"}
                      </span>
                      <h3>{notification.title}</h3>
                      <p>{notification.body}</p>
                    </div>
                    {!notification.read_at && (
                      <button
                        type="button"
                        className="awra-text-button"
                        onClick={() => onMarkNotificationRead?.(notification.id)}
                        disabled={notificationPendingIds.includes(notification.id)}
                        aria-label={`Mark ${notification.title} as read`}
                      >
                        Read
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : activeTab === "activity" ? (
          <ActivityView activitySummary={activitySummary} user={user} profile={profile} />
        ) : activeTab === "tasks" ? (
          <TasksView
            tasks={tasks}
            tasksLoading={tasksLoading}
            taskTitle={taskTitle}
            onTaskTitleChange={onTaskTitleChange}
            onAddTask={onAddTask}
            taskSubmitting={taskSubmitting}
            taskError={taskError}
            pendingTaskIds={pendingTaskIds}
            onToggleTask={onToggleTask}
            onDeleteTask={onDeleteTask}
            user={user}
            profile={profile}
          />
        ) : (
          <div className="awra-practice__content">
            <section className="awra-practice__hero">
              <AwraBigLogo />
              <h2 className="awra-practice__heading">Ready to practice?</h2>
              <p className="awra-practice__subtitle">{subtitle}</p>
              <div className="awra-online">
                <span className="awra-online__dot" aria-hidden="true" />
                <span>14 students online</span>
              </div>
            </section>

            <div className="awra-practice__action">
              <button type="button" className="awra-practice-button" onClick={onPractice}>
                Practice
              </button>
              <p className="awra-practice__guideline">
                Mistakes are welcome; disrespect is not.
              </p>
            </div>
          </div>
        )}
      </main>

      <nav className="awra-bottom-nav" aria-label="Main navigation">
        <button
          type="button"
          className={`awra-bottom-nav__item ${activeTab === "practice" && !notificationsOpen ? "is-active" : ""}`}
          onClick={() => {
            setActiveTab("practice");
            setNotificationsOpen(false);
          }}
          aria-current={activeTab === "practice" && !notificationsOpen ? "page" : undefined}
        >
          <span className="awra-bottom-nav__indicator" />
          <PracticeIcon />
          <span>Practice</span>
        </button>
        <div className="awra-bottom-nav__anchor">
          <button
            type="button"
            className={`awra-bottom-nav__item ${activeTab === "activity" && !notificationsOpen ? "is-active" : ""}`}
            onClick={() => {
              setActiveTab("activity");
              setNotificationsOpen(false);
              setProfileOpen(false);
            }}
            aria-current={activeTab === "activity" && !notificationsOpen ? "page" : undefined}
          >
            <span className="awra-bottom-nav__indicator" />
            <ActivityIcon />
            <span>Activity</span>
          </button>
        </div>
        <button
          type="button"
          className={`awra-bottom-nav__item ${activeTab === "tasks" && !notificationsOpen ? "is-active" : ""}`}
          onClick={() => {
            setActiveTab("tasks");
            setNotificationsOpen(false);
            setProfileOpen(false);
          }}
          aria-current={activeTab === "tasks" && !notificationsOpen ? "page" : undefined}
        >
          <span className="awra-bottom-nav__indicator" />
          <TasksIcon />
          <span>Tasks</span>
        </button>
        <div className="awra-profile awra-bottom-nav__anchor" ref={profileRef}>
          <button
            type="button"
            className="awra-bottom-nav__item"
            onClick={() => {
              setProfileOpen((open) => !open);
            }}
            aria-haspopup="dialog"
            aria-expanded={profileOpen}
          >
            <ProfileIcon />
            <span>Profile</span>
          </button>

          {profileOpen && (
            <section className="awra-popover awra-popover--profile" role="dialog" aria-label="Account">
              <div className="awra-popover__identity">
                <span className="awra-profile__icon awra-profile__icon--large"><ProfileIcon /></span>
                <span className="awra-popover__name">{accountName}</span>
                <button
                  type="button"
                  className="awra-popover__close"
                  onClick={() => setProfileOpen(false)}
                  aria-label="Close account menu"
                >
                  <CloseIcon />
                </button>
              </div>
              {/* TODO: Re-enable guest flow: restore VIP and position badges in the profile popover.
              {(badge || vip) && (
                <p className="awra-popover__badge">{vip ? "VIP" : badge}</p>
              )}
              */}
              <button
                type="button"
                className="awra-popover__signout"
                onClick={onSignOut}
              >
                Sign Out
              </button>
            </section>
          )}
        </div>
      </nav>
    </div>
  );
}