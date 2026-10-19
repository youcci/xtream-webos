/* Once-armed early root dispatcher. No symbol interposition. */
typedef struct probe_stream probe_stream;
extern char *getenv(const char *);
extern unsigned int getuid(void);
extern int getpid(void);
extern int access(const char *, int);
extern int mkdir(const char *, unsigned int);
extern int rename(const char *, const char *);
extern probe_stream *fopen(const char *, const char *);
extern char *fgets(char *, int, probe_stream *);
extern int fprintf(probe_stream *, const char *, ...);
extern int fclose(probe_stream *);
extern int fileno(probe_stream *);
extern int fchmod(int, unsigned int);
extern int fork(void);
extern int unsetenv(const char *);
extern int execl(const char *, const char *, ...);
extern int open(const char *, int, ...);
extern int dup2(int, int);
extern int close(int);
extern int waitpid(int, int *, int);
extern int usleep(unsigned int);
extern int kill(int, int);
extern void _exit(int) __attribute__((noreturn));

static int same(const char *a, const char *b) {
    if (!a) return 0;
    while (*a && *a == *b) { ++a; ++b; }
    return *a == *b;
}

static int dispatch(const char *mode) {
    int child = fork();
    if (child < 0) return -1;
    if (child == 0) {
        unsetenv("LD_PRELOAD");
        unsetenv("XTREAM_EARLY_ENTRY");
        unsetenv("XTREAM_EARLY_DISPATCH");
        int fd = open("/dev/null", 2);
        if (fd >= 0) { dup2(fd, 0); dup2(fd, 1); dup2(fd, 2); if (fd > 2) close(fd); }
        execl("/usr/bin/systemd-run", "systemd-run", "--unit=xtream-early-entry",
              "--service-type=oneshot", "--remain-after-exit", "--no-block",
              "--property=UMask=0077", "--property=TimeoutStartSec=120",
              "/bin/sh", "/var/lib/xtream-native/early-entry/dispatch.sh", mode, (char *)0);
        _exit(127);
    }
    int status = 0;
    for (int n = 0; n < 200; ++n) {
        int result = waitpid(child, &status, 1);
        if (result == child) return status;
        if (result < 0) return -2;
        usleep(10000);
    }
    kill(child, 9);
    waitpid(child, &status, 0);
    return -3;
}

__attribute__((constructor)) static void probe(void) {
    const char *enabled = getenv("XTREAM_EARLY_ENTRY");
    if (!enabled || enabled[0] != '1' || enabled[1] || getuid() != 0) return;
    if (access("/var/lib/xtream-native/enabled", 0) != 0) return;
    if (access("/var/luna/preferences/webosbrew_failsafe", 0) == 0) return;
    /* A later TTS restart in this boot must not consume the next boot lease. */
    (void)mkdir("/run/xtream-native", 0700);
    int once = open("/run/xtream-native/early-entry.claim", 1|64|128, 0600);
    if (once < 0) return;
    close(once);
    if (rename("/var/lib/xtream-native/early-entry/armed",
               "/var/lib/xtream-native/early-entry/claimed") != 0) return;
    char uptime[96] = "unavailable\n";
    probe_stream *in = fopen("/proc/uptime", "r");
    if (in) { fgets(uptime, sizeof(uptime), in); fclose(in); }
    probe_stream *out = fopen("/var/lib/xtream-native/early-entry/marker.log", "w");
    if (!out) return;
    fchmod(fileno(out), 0600);
    fprintf(out, "uptime=%suid=%u\npid=%d\n", uptime, getuid(), getpid());
    fclose(out);
    const char *mode = getenv("XTREAM_EARLY_DISPATCH");
    if (same(mode, "probe") || same(mode, "start")) {
        int status = dispatch(mode);
        out = fopen("/var/lib/xtream-native/early-entry/dispatch-result.log", "w");
        if (out) { fchmod(fileno(out), 0600); fprintf(out, "status=%d\n", status); fclose(out); }
    }
}
