/*
 * Campus Event Manager - core logic in C
 * ---------------------------------------
 * Built to be compiled to WebAssembly with Emscripten, but it also
 * compiles with plain gcc so you can test it in a normal console.
 *
 * Rules used everywhere:
 *   - Times are "minutes since midnight"  (9:30 AM = 570, 2:00 PM = 840)
 *   - Dates are whole numbers like 20261105 (YYYYMMDD) when comparing events
 *   - Functions that return text use ONE shared output buffer, so read the
 *     result before calling another text function.
 *   - No printf/scanf menus here. The website replaces them.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

#define OUT_SIZE        8192
#define MAX_ITEMS       64
#define NAME_LEN        48
#define LINE_LEN        160
#define MIN_ATTENDANCE  75.0

/* ------------------------------------------------------------------ */
/*  Shared output buffer helpers                                      */
/* ------------------------------------------------------------------ */

static char out[OUT_SIZE];
static int  out_len = 0;

static void out_reset(void)
{
    out_len = 0;
    out[0] = '\0';
}

static void out_add(const char *fmt, ...)
{
    va_list args;
    int written;

    if (out_len >= OUT_SIZE - 1) return;
    va_start(args, fmt);
    written = vsnprintf(out + out_len, OUT_SIZE - out_len, fmt, args);
    va_end(args);
    if (written > 0) {
        out_len += written;
        if (out_len > OUT_SIZE - 1) out_len = OUT_SIZE - 1;
    }
}

static const char *out_error(const char *msg)
{
    out_reset();
    out_add("ERROR %s\n", msg);
    return out;
}

/* Copy the next line of text into 'line'. Returns pointer to the start of
 * the following line, or NULL when there is no more text. */
static const char *next_line(const char *p, char *line, int size)
{
    int i = 0;

    if (p == NULL || *p == '\0') return NULL;
    while (*p != '\0' && *p != '\n') {
        if (*p != '\r' && i < size - 1) line[i++] = *p;
        p++;
    }
    line[i] = '\0';
    if (*p == '\n') p++;
    return p;
}

/* ------------------------------------------------------------------ */
/*  1. Date helpers                                                   */
/* ------------------------------------------------------------------ */

static int is_leap(int y)
{
    return (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
}

static int days_in_month(int m, int y)
{
    static const int days[12] = {31, 28, 31, 30, 31, 30,
                                 31, 31, 30, 31, 30, 31};
    if (m == 2 && is_leap(y)) return 29;
    return days[m - 1];
}

/* Weekday of any date: 0 = Sunday, 1 = Monday ... 6 = Saturday.
 * (Sakamoto's method - this maps a date to the timetable.) */
EXPORT int get_weekday(int d, int m, int y)
{
    static const int t[12] = {0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4};

    if (m < 3) y -= 1;
    return (y + y / 4 - y / 100 + y / 400 + t[m - 1] + d) % 7;
}

/* Number of days in a month (the calendar needs this to draw the grid). */
EXPORT int get_days_in_month(int m, int y)
{
    if (m < 1 || m > 12) return 0;
    return days_in_month(m, y);
}

/* The day before an event, as "YYYY-MM-DD".
 * This is the suggested date to apply for Duty Leave. */
EXPORT const char *dl_apply_date(int d, int m, int y)
{
    d -= 1;
    if (d < 1) {
        m -= 1;
        if (m < 1) {
            m = 12;
            y -= 1;
        }
        d = days_in_month(m, y);
    }
    out_reset();
    out_add("%04d-%02d-%02d", y, m, d);
    return out;
}

/* ------------------------------------------------------------------ */
/*  2. Clash detection (interval overlap)                             */
/* ------------------------------------------------------------------ */

/* Two time windows [s1,e1) and [s2,e2) overlap when each one starts
 * before the other one ends. */
static int intervals_overlap(int s1, int e1, int s2, int e2)
{
    return (s1 < e2 && s2 < e1);
}

/* Event vs event. Different dates never clash. Returns 1 if they clash. */
EXPORT int check_clash(int date1, int start1, int end1,
                       int date2, int start2, int end2)
{
    if (date1 != date2) return 0;
    return intervals_overlap(start1, end1, start2, end2);
}

/* Lecture vs event, with a travel/preparation buffer before the event.
 * Returns 1 if the lecture needs Duty Leave. */
EXPORT int check_lecture_overlap(int ev_start, int ev_end,
                                 int lec_start, int lec_end, int buffer)
{
    return intervals_overlap(ev_start - buffer, ev_end, lec_start, lec_end);
}

/* A new event against everything the student already registered for.
 *
 * Input text:
 *   line 1:   date start end                (the new event)
 *   other:    id date start end             (one line per registered event)
 * Output:  "CLASH <id>"  or  "NONE"
 */
EXPORT const char *find_clash(const char *input)
{
    char line[LINE_LEN], id[NAME_LEN];
    const char *p;
    int date, start, end, rdate, rstart, rend;

    p = next_line(input, line, LINE_LEN);
    if (p == NULL || sscanf(line, "%d %d %d", &date, &start, &end) != 3)
        return out_error("first line must be: date start end");

    out_reset();
    while ((p = next_line(p, line, LINE_LEN)) != NULL) {
        if (sscanf(line, "%47s %d %d %d", id, &rdate, &rstart, &rend) != 4)
            continue;
        if (check_clash(date, start, end, rdate, rstart, rend)) {
            out_add("CLASH %s", id);
            return out;
        }
    }
    out_add("NONE");
    return out;
}

/* ------------------------------------------------------------------ */
/*  3. Day planner (the heart of the project)                         */
/* ------------------------------------------------------------------ */

typedef struct {
    int  is_event;          /* 1 = the event itself, 0 = a lecture   */
    int  start, end;
    int  needs_dl;          /* lectures only                         */
    char subject[NAME_LEN];
} TimelineItem;

static int compare_timeline(const void *a, const void *b)
{
    const TimelineItem *x = (const TimelineItem *)a;
    const TimelineItem *y = (const TimelineItem *)b;

    if (x->start != y->start) return x->start - y->start;
    return x->is_event - y->is_event;   /* lecture before event on a tie */
}

/* Builds one chronological timeline of lectures and the event.
 *
 * Input text:
 *   line 1:   event_start event_end buffer_minutes
 *   other:    start end subject             (that weekday's lectures)
 *
 * Output text (sorted by time):
 *   LECTURE <start> <end> <subject> ATTEND
 *   LECTURE <start> <end> <subject> APPLY_DL
 *   EVENT   <start> <end>
 *   SUMMARY <lectures_needing_dl> <lectures_to_attend>
 */
EXPORT const char *plan_day(const char *input)
{
    TimelineItem items[MAX_ITEMS];
    char line[LINE_LEN], subject[NAME_LEN];
    const char *p;
    int ev_start, ev_end, buffer, start, end;
    int count = 0, dl_count = 0, attend_count = 0, i;

    p = next_line(input, line, LINE_LEN);
    if (p == NULL || sscanf(line, "%d %d %d", &ev_start, &ev_end, &buffer) != 3)
        return out_error("first line must be: event_start event_end buffer");
    if (ev_end <= ev_start)
        return out_error("event must end after it starts");

    /* the event itself */
    items[count].is_event = 1;
    items[count].start = ev_start;
    items[count].end = ev_end;
    items[count].needs_dl = 0;
    strcpy(items[count].subject, "Event");
    count++;

    /* every lecture of that weekday */
    while ((p = next_line(p, line, LINE_LEN)) != NULL && count < MAX_ITEMS) {
        if (sscanf(line, "%d %d %47s", &start, &end, subject) != 3) continue;
        items[count].is_event = 0;
        items[count].start = start;
        items[count].end = end;
        items[count].needs_dl =
            check_lecture_overlap(ev_start, ev_end, start, end, buffer);
        strcpy(items[count].subject, subject);
        count++;
    }

    qsort(items, count, sizeof(TimelineItem), compare_timeline);

    out_reset();
    for (i = 0; i < count; i++) {
        if (items[i].is_event) {
            out_add("EVENT %d %d\n", items[i].start, items[i].end);
        } else {
            out_add("LECTURE %d %d %s %s\n", items[i].start, items[i].end,
                    items[i].subject,
                    items[i].needs_dl ? "APPLY_DL" : "ATTEND");
            if (items[i].needs_dl) dl_count++;
            else attend_count++;
        }
    }
    out_add("SUMMARY %d %d\n", dl_count, attend_count);
    return out;
}

/* ------------------------------------------------------------------ */
/*  4. DL and attendance projection                                   */
/* ------------------------------------------------------------------ */

static double percent(int attended, int held)
{
    if (held <= 0) return 100.0;
    return 100.0 * (double)attended / (double)held;
}

/* For each subject, show attendance now and after the upcoming events.
 *
 * Input text, one subject per line:
 *   subject held attended missed
 *   (missed = lectures of that subject that clash with registered events)
 *
 * Rejected DL: the missed lectures count as held, but not attended.
 * Approved DL: the missed lectures count as held AND attended.
 *
 * Output, one line per subject:
 *   subject now rejected approved flag
 * flag = 1 if attendance would fall below 75% when DL is rejected.
 */
EXPORT const char *attendance_projection(const char *input)
{
    char line[LINE_LEN], subject[NAME_LEN];
    const char *p = input;
    int held, attended, missed;
    double now, rejected, approved;

    out_reset();
    while ((p = next_line(p, line, LINE_LEN)) != NULL) {
        if (sscanf(line, "%47s %d %d %d", subject, &held, &attended, &missed) != 4)
            continue;
        now      = percent(attended, held);
        rejected = percent(attended, held + missed);
        approved = percent(attended + missed, held + missed);
        out_add("%s %.1f %.1f %.1f %d\n", subject, now, rejected, approved,
                rejected < MIN_ATTENDANCE ? 1 : 0);
    }
    if (out_len == 0) return out_error("no valid subject lines");
    return out;
}

/* ------------------------------------------------------------------ */
/*  5. Sorting events by date, then by time                           */
/* ------------------------------------------------------------------ */

typedef struct {
    char id[NAME_LEN];
    int  date;
    int  start;
} SortItem;

static int compare_events(const void *a, const void *b)
{
    const SortItem *x = (const SortItem *)a;
    const SortItem *y = (const SortItem *)b;

    if (x->date != y->date) return x->date - y->date;
    return x->start - y->start;
}

/* Input:  one event per line:  id date start
 * Output: the ids, one per line, in order of date and then time. */
EXPORT const char *sort_events(const char *input)
{
    SortItem items[MAX_ITEMS];
    char line[LINE_LEN];
    const char *p = input;
    int count = 0, i;

    while ((p = next_line(p, line, LINE_LEN)) != NULL && count < MAX_ITEMS) {
        if (sscanf(line, "%47s %d %d", items[count].id,
                   &items[count].date, &items[count].start) == 3)
            count++;
    }
    qsort(items, count, sizeof(SortItem), compare_events);

    out_reset();
    for (i = 0; i < count; i++) out_add("%s\n", items[i].id);
    return out;
}

/* ------------------------------------------------------------------ */
/*  Console test (only when compiled with gcc, not Emscripten)        */
/*      gcc -DCAMPUS_TEST campus.c -o campus_test && ./campus_test    */
/* ------------------------------------------------------------------ */

#ifdef CAMPUS_TEST
int main(void)
{
    printf("Weekday of 5 Nov 2026 (0=Sun): %d\n", get_weekday(5, 11, 2026));
    printf("DL apply date for 1 Mar 2028: %s\n", dl_apply_date(1, 3, 2028));

    printf("\nClash check:\n%s\n\n", find_clash(
        "20261105 600 720\n"
        "E1 20261105 660 780\n"
        "E2 20261106 600 720\n"));

    printf("Day plan (event 11:00-13:00, 30 min buffer):\n%s\n", plan_day(
        "660 780 30\n"
        "540 590 Maths\n"
        "600 650 Physics\n"
        "700 750 Programming\n"
        "800 850 English\n"));

    printf("Attendance projection:\n%s\n", attendance_projection(
        "Maths 20 17 2\n"
        "Physics 18 12 1\n"
        "Programming 22 22 3\n"));

    printf("Sorted events:\n%s", sort_events(
        "B 20261106 540\n"
        "A 20261105 900\n"
        "C 20261105 540\n"));
    return 0;
}
#endif
