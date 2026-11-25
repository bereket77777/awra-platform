import { useState, useRef, useEffect } from "react";
import "./PracticeScreen.css";

const LEVELS = ["Beginner", "Intermediate", "Advanced"];

// Placeholder activity data — wire this up to real session history.
const ACTIVITY = {
    today: "12 min",
    thisWeek: "1h 48m",
    thisMonth: "6h 20m",
    // Relative minutes practiced per day, oldest to newest (7-day window).
    trend: [4, 12, 0, 18, 9, 22, 12],
};

function UserIcon() {
    return (
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10.25" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="12" cy="9.75" r="3.25" stroke="currentColor" strokeWidth="1.3" />
            <path
                d="M5.75 18.25c1.25-2.6 3.6-4 6.25-4s5 1.4 6.25 4"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
            />
        </svg>
    );
}

function ClockIcon() {
    return (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
            <circle cx="12" cy="12.5" r="8.25" stroke="currentColor" strokeWidth="1.3" />
            <path d="M12 8v4.75l3.1 1.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M9.5 2.75h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
    );
}

function CloseIcon() {
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
    );
}

function ActivityGraph({ data }) {
    const max = Math.max(...data, 1);
    return (
        <div className="activity-graph" role="img" aria-label="Speaking minutes over the last 7 days">
            {data.map((value, i) => (
                <div className="activity-graph__col" key={i}>
                    <div
                        className="activity-graph__bar"
                        style={{ height: `${Math.max((value / max) * 100, 4)}%` }}
                    />
                </div>
            ))}
        </div>
    );
}

export default function PracticeScreen({ studentName = "Bereket Girma" }) {
    const [level, setLevel] = useState("Intermediate");
    const [activityOpen, setActivityOpen] = useState(false);
    const [profileOpen, setProfileOpen] = useState(false);
    const profileRef = useRef(null);
    const activityRef = useRef(null);

    // Close either panel on outside click or Escape.
    useEffect(() => {
        function onPointerDown(e) {
            if (profileOpen && profileRef.current && !profileRef.current.contains(e.target)) {
                setProfileOpen(false);
            }
            if (activityOpen && activityRef.current && !activityRef.current.contains(e.target)) {
                setActivityOpen(false);
            }
        }
        function onKeyDown(e) {
            if (e.key === "Escape") {
                setProfileOpen(false);
                setActivityOpen(false);
            }
        }
        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("mousedown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [profileOpen, activityOpen]);

    return (
        <div className="awra-screen">
            <header className="awra-header">
                <div className="awra-profile" ref={profileRef}>
                    <button
                        type="button"
                        className="awra-profile__trigger"
                        onClick={() => setProfileOpen((open) => !open)}
                        aria-haspopup="dialog"
                        aria-expanded={profileOpen}
                    >
                        <span className="awra-icon-btn">
                            <UserIcon />
                        </span>
                        <span className="awra-profile__name">{studentName}</span>
                    </button>

                    {profileOpen && (
                        <div className="awra-popover awra-popover--profile" role="dialog" aria-label="Account">
                            <div className="awra-popover__header">
                                <span className="awra-icon-btn awra-icon-btn--lg">
                                    <UserIcon />
                                </span>
                                <div>
                                    <p className="awra-popover__title">{studentName}</p>
                                    <p className="awra-popover__subtitle">Intermediate speaker</p>
                                </div>
                                <button
                                    type="button"
                                    className="awra-popover__close"
                                    onClick={() => setProfileOpen(false)}
                                    aria-label="Close account view"
                                >
                                    <CloseIcon />
                                </button>
                            </div>
                            <div className="awra-popover__list">
                                <button type="button" className="awra-popover__item">Edit profile</button>
                                <button type="button" className="awra-popover__item">Preferences</button>
                                <button type="button" className="awra-popover__item">Sign out</button>
                            </div>
                        </div>
                    )}
                </div>
            </header>

            <div className="awra-body">
                <div className="awra-rail" ref={activityRef}>
                    <button
                        type="button"
                        className="awra-icon-btn"
                        onClick={() => setActivityOpen((open) => !open)}
                        aria-haspopup="dialog"
                        aria-expanded={activityOpen}
                        aria-label="My speaking activity"
                    >
                        <ClockIcon />
                    </button>

                    {activityOpen && (
                        <div className="awra-popover awra-popover--activity" role="dialog" aria-label="My Speaking Activity">
                            <div className="awra-popover__header awra-popover__header--tight">
                                <p className="awra-popover__title">My Speaking Activity</p>
                                <button
                                    type="button"
                                    className="awra-popover__close"
                                    onClick={() => setActivityOpen(false)}
                                    aria-label="Close speaking activity"
                                >
                                    <CloseIcon />
                                </button>
                            </div>

                            <dl className="activity-stats">
                                <div className="activity-stats__row">
                                    <dt>Today</dt>
                                    <dd>{ACTIVITY.today}</dd>
                                </div>
                                <div className="activity-stats__row">
                                    <dt>This week</dt>
                                    <dd>{ACTIVITY.thisWeek}</dd>
                                </div>
                                <div className="activity-stats__row">
                                    <dt>This month</dt>
                                    <dd>{ACTIVITY.thisMonth}</dd>
                                </div>
                            </dl>

                            <ActivityGraph data={ACTIVITY.trend} />
                        </div>
                    )}
                </div>

                <main className="awra-main">
                    <h1 className="awra-heading">Ready to practice?</h1>

                    <div className="awra-levels" role="radiogroup" aria-label="Proficiency level">
                        {LEVELS.map((option) => (
                            <button
                                key={option}
                                type="button"
                                role="radio"
                                aria-checked={level === option}
                                className={`awra-level${level === option ? " awra-level--active" : ""}`}
                                onClick={() => setLevel(option)}
                            >
                                {option}
                            </button>
                        ))}
                    </div>

                    <p className="awra-subtext">Find a partner for a ten-minute speaking session.</p>

                    <div className="awra-online">
                        <span className="awra-online__dot" aria-hidden="true" />
                        <span>14 students online</span>
                    </div>

                    <button type="button" className="awra-practice-btn">
                        Practice
                    </button>
                </main>
            </div>
        </div>
    );
}
