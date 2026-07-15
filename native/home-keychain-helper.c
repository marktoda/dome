#define __STDC_WANT_LIB_EXT1__ 1
#include <CoreFoundation/CoreFoundation.h>
#include <CommonCrypto/CommonDigest.h>
#include <Security/Security.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <pwd.h>
#include <readpassphrase.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define SECRET_CAPACITY (16 * 1024 + 2)
#define ID_CAPACITY 129
#define ACCOUNT_CAPACITY 256
#define SERVICE "com.dome.home.credentials.v1"
#define SLOT "model.anthropic.api-key"
#define PROVIDER_RELATIVE "app/assets/model-providers/anthropic.ts"

#ifndef SHIPPED_PROVIDER_SHA256
#error SHIPPED_PROVIDER_SHA256 must bind the packaged provider bytes
#endif
#ifndef SHIPPED_BUN_SHA256
#error SHIPPED_BUN_SHA256 must bind the packaged Bun bytes
#endif

static int direct_owned(const char *path, mode_t required_type, struct stat *result);

/* macOS deployment targets do not all export explicit_bzero; memset_s has
 * the same compiler-resistant clearing contract across the supported SDKs. */
static void explicit_bzero(void *bytes, size_t length) {
  (void)memset_s(bytes, length, 0, length);
}

static int fail(const char *message, int code) {
  fputs(message, stderr);
  fputc('\n', stderr);
  return code;
}

static int same_file(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
    left->st_uid == right->st_uid && left->st_nlink == right->st_nlink &&
    left->st_mode == right->st_mode && left->st_size == right->st_size &&
    left->st_mtimespec.tv_sec == right->st_mtimespec.tv_sec &&
    left->st_mtimespec.tv_nsec == right->st_mtimespec.tv_nsec &&
    left->st_ctimespec.tv_sec == right->st_ctimespec.tv_sec &&
    left->st_ctimespec.tv_nsec == right->st_ctimespec.tv_nsec;
}

static int stable_direct_owned(const char *path, mode_t required_type) {
  struct stat before;
  struct stat after;
  return direct_owned(path, required_type, &before) && lstat(path, &after) == 0 && same_file(&before, &after);
}

static int owned_keychain_path(const char *path) {
  struct passwd *owner = getpwuid(getuid());
  if (owner == NULL || owner->pw_dir == NULL || !stable_direct_owned(owner->pw_dir, S_IFDIR)) return 0;
  char root[PATH_MAX];
  char library[PATH_MAX];
  if (snprintf(library, sizeof(library), "%s/Library", owner->pw_dir) >= (int)sizeof(library) ||
      !stable_direct_owned(library, S_IFDIR) ||
      snprintf(root, sizeof(root), "%s/Keychains", library) >= (int)sizeof(root) ||
      !stable_direct_owned(root, S_IFDIR)) return 0;
  size_t root_length = strlen(root);
  if (strncmp(path, root, root_length) != 0 || path[root_length] != '/') return 0;
  char cursor[PATH_MAX];
  if (strlen(path) >= sizeof(cursor)) return 0;
  strcpy(cursor, path);
  char *slash = strrchr(cursor, '/');
  if (slash == NULL) return 0;
  *slash = '\0';
  while (strcmp(cursor, root) != 0) {
    if (!stable_direct_owned(cursor, S_IFDIR)) return 0;
    slash = strrchr(cursor, '/');
    if (slash == NULL) return 0;
    *slash = '\0';
    if (strlen(cursor) < root_length) return 0;
  }
  return stable_direct_owned(path, S_IFREG);
}

static int credential_status_code(OSStatus status) {
  if (status == errSecSuccess) return 0;
  if (status == errSecItemNotFound) return 44;
  if (status == errSecInteractionNotAllowed || status == errSecNotAvailable) return 5;
  if (status == errSecAuthFailed || status == errSecUserCanceled) return 3;
  return 4;
}

static int allowlisted_env(const char *name, char *entry, size_t capacity) {
  const char *value = getenv(name);
  if (value == NULL) return 0;
  int length = snprintf(entry, capacity, "%s=%s", name, value);
  return length >= 0 && (size_t)length < capacity ? 1 : -1;
}

static void sha256_hex(const void *bytes, size_t length, char output[65]) {
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes, (CC_LONG)length, digest);
  for (size_t index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
    snprintf(output + index * 2, 3, "%02x", digest[index]);
  }
  output[64] = '\0';
}

static int open_verified_provider(const char *path, int *result_fd) {
  int fd = open(path, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return 0;
  struct stat before;
  struct stat after;
  struct stat named;
  CC_SHA256_CTX context;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  unsigned char buffer[16 * 1024];
  ssize_t length;
  int valid = fstat(fd, &before) == 0 && S_ISREG(before.st_mode) && before.st_uid == getuid() &&
    before.st_nlink == 1 && (before.st_mode & 0022) == 0 && before.st_size > 0 && before.st_size <= 1024 * 1024;
  if (valid) {
    CC_SHA256_Init(&context);
    while ((length = read(fd, buffer, sizeof(buffer))) > 0) CC_SHA256_Update(&context, buffer, (CC_LONG)length);
    valid = length == 0 && lseek(fd, 0, SEEK_SET) == 0;
    CC_SHA256_Final(digest, &context);
  }
  char hex[65];
  if (valid) {
    for (size_t index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) snprintf(hex + index * 2, 3, "%02x", digest[index]);
    hex[64] = '\0';
    valid = strcmp(hex, SHIPPED_PROVIDER_SHA256) == 0 && fstat(fd, &after) == 0 &&
      lstat(path, &named) == 0 && same_file(&before, &after) &&
      before.st_dev == named.st_dev && before.st_ino == named.st_ino;
  }
  explicit_bzero(buffer, sizeof(buffer));
  explicit_bzero(digest, sizeof(digest));
  explicit_bzero(hex, sizeof(hex));
  if (!valid) { close(fd); return 0; }
  *result_fd = fd;
  return 1;
}

static int open_verified_executable(
  const char *path,
  int *result_fd,
  struct stat *result_identity
) {
  int fd = open(path, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return 0;
  struct stat before;
  struct stat after;
  struct stat named;
  CC_SHA256_CTX context;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  unsigned char buffer[16 * 1024];
  ssize_t length;
  int valid = fstat(fd, &before) == 0 && S_ISREG(before.st_mode) && before.st_uid == getuid() &&
    before.st_nlink == 1 && (before.st_mode & 0022) == 0 && (before.st_mode & 0111) != 0 &&
    before.st_size > 0 && before.st_size <= 1024LL * 1024LL * 1024LL;
  if (valid) {
    CC_SHA256_Init(&context);
    while ((length = read(fd, buffer, sizeof(buffer))) > 0) CC_SHA256_Update(&context, buffer, (CC_LONG)length);
    valid = length == 0 && lseek(fd, 0, SEEK_SET) == 0;
    CC_SHA256_Final(digest, &context);
  }
  char hex[65];
  if (valid) {
    for (size_t index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) snprintf(hex + index * 2, 3, "%02x", digest[index]);
    hex[64] = '\0';
    valid = strcmp(hex, SHIPPED_BUN_SHA256) == 0 && fstat(fd, &after) == 0 &&
      lstat(path, &named) == 0 && same_file(&before, &after) &&
      before.st_dev == named.st_dev && before.st_ino == named.st_ino &&
      fcntl(fd, F_SETFD, FD_CLOEXEC) == 0;
  }
  explicit_bzero(buffer, sizeof(buffer));
  explicit_bzero(digest, sizeof(digest));
  explicit_bzero(hex, sizeof(hex));
  if (!valid) { close(fd); return 0; }
  *result_fd = fd;
  *result_identity = before;
  return 1;
}

static int exec_reproved_named_inode(
  const char *path,
  int fd,
  const struct stat *identity,
  char *const argv[],
  char *const env[]
) {
  struct stat held;
  struct stat named;
  if (fstat(fd, &held) == 0 && lstat(path, &named) == 0 &&
      same_file(identity, &held) && same_file(identity, &named)) {
    /* macOS has no fexecve. This exact final named-inode reproof minimizes,
     * but cannot eliminate, the platform's path-based exec race. */
    return execve(path, argv, env);
  }
  errno = ESTALE;
  return -1;
}

static int direct_owned(const char *path, mode_t required_type, struct stat *result) {
  struct stat info;
  if (lstat(path, &info) != 0 || (info.st_mode & S_IFMT) != required_type ||
      info.st_uid != getuid() || (required_type == S_IFREG && info.st_nlink != 1) ||
      (info.st_mode & 0022) != 0) return 0;
  char canonical[PATH_MAX];
  return realpath(path, canonical) != NULL && strcmp(canonical, path) == 0 &&
    (result == NULL || (*result = info, 1));
}

static int read_vault_id(const char *vault, char id[ID_CAPACITY]) {
  char path[PATH_MAX];
  if (snprintf(path, sizeof(path), "%s/.dome/state/product-host-id", vault) >= (int)sizeof(path)) return 0;
  int fd = open(path, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return 0;
  struct stat before;
  struct stat after;
  struct stat named;
  ssize_t length = -1;
  if (fstat(fd, &before) == 0 && S_ISREG(before.st_mode) && before.st_uid == getuid() &&
      before.st_nlink == 1 && (before.st_mode & 0777) == 0600 && before.st_size > 0 &&
      before.st_size < ID_CAPACITY) {
    length = read(fd, id, ID_CAPACITY - 1);
  }
  int saved_errno = errno;
  int stable = fstat(fd, &after) == 0 && lstat(path, &named) == 0 &&
    same_file(&before, &after) && before.st_dev == named.st_dev && before.st_ino == named.st_ino;
  close(fd);
  errno = saved_errno;
  if (length <= 0 || !stable || length != before.st_size) return 0;
  id[length] = '\0';
  if (length > 0 && id[length - 1] == '\n') id[--length] = '\0';
  if (length <= 0 || length > 128) return 0;
  for (ssize_t index = 0; index < length; index++) {
    char byte = id[index];
    if (!((byte >= 'A' && byte <= 'Z') || (byte >= 'a' && byte <= 'z') ||
        (byte >= '0' && byte <= '9') || byte == '_' || byte == '-')) return 0;
  }
  return 1;
}

static int open_bound_keychain(SecKeychainRef *keychain) {
  OSStatus status = SecKeychainCopyDefault(keychain);
  if (status != errSecSuccess || *keychain == NULL) return 0;
  char path[PATH_MAX];
  UInt32 path_length = (UInt32)sizeof(path);
  status = SecKeychainGetPath(*keychain, &path_length, path);
  if (status != errSecSuccess || path_length >= sizeof(path)) return 0;
  path[path_length] = '\0';
  struct stat before;
  struct stat after;
  if (!owned_keychain_path(path) || !direct_owned(path, S_IFREG, &before) ||
      lstat(path, &after) != 0 || !same_file(&before, &after) || !owned_keychain_path(path)) return 0;
  return 1;
}

static OSStatus find_item(
  SecKeychainRef keychain,
  const char *account,
  UInt32 *password_length,
  void **password_data,
  SecKeychainItemRef *item
) {
  return SecKeychainFindGenericPassword(
    keychain,
    (UInt32)strlen(SERVICE), SERVICE,
    (UInt32)strlen(account), account,
    password_length, password_data, item
  );
}

static int model_provider_exec(
  const char *vault,
  SecKeychainRef keychain,
  const char *account
) {
  UInt32 password_length = 0;
  void *password_data = NULL;
  SecKeychainItemRef item = NULL;
  OSStatus status = find_item(keychain, account, &password_length, &password_data, &item);
  if (item != NULL) CFRelease(item);
  if (status == errSecItemNotFound) return 44;
  if (status == errSecSuccess && (password_data == NULL || password_length == 0 ||
      password_length > 16 * 1024 || memchr(password_data, '\0', password_length) != NULL)) {
    status = errSecDecode;
  }
  if (status != errSecSuccess) {
    if (password_data != NULL) {
      explicit_bzero(password_data, password_length);
      SecKeychainItemFreeContent(NULL, password_data);
    }
    return credential_status_code(status);
  }

  int result = 4;
  char executable_source[PATH_MAX];
  char executable[PATH_MAX];
  uint32_t executable_length = (uint32_t)sizeof(executable_source);
  char *credential = NULL;
  size_t credential_length = 0;
  size_t credential_capacity = 0;
  char *home = NULL;
  int bun_fd = -1;
  int provider_fd = -1;
  struct stat bun_identity;
  if (_NSGetExecutablePath(executable_source, &executable_length) != 0 ||
      realpath(executable_source, executable) == NULL) goto cleanup;
  if (!stable_direct_owned(executable, S_IFREG)) goto cleanup;
  char *last_slash = strrchr(executable, '/');
  if (last_slash == NULL) goto cleanup;
  *last_slash = '\0';
  if (!stable_direct_owned(executable, S_IFDIR)) goto cleanup;
  char bun[PATH_MAX];
  char provider[PATH_MAX];
  char artifact_source[PATH_MAX];
  char artifact[PATH_MAX];
  if (snprintf(bun, sizeof(bun), "%s/bun", executable) >= (int)sizeof(bun) ||
      snprintf(artifact_source, sizeof(artifact_source), "%s/..", executable) >= (int)sizeof(artifact_source) ||
      realpath(artifact_source, artifact) == NULL || !stable_direct_owned(artifact, S_IFDIR) ||
      snprintf(provider, sizeof(provider), "%s/%s", artifact, PROVIDER_RELATIVE) >= (int)sizeof(provider)) {
    goto cleanup;
  }
  if (!open_verified_executable(bun, &bun_fd, &bun_identity) ||
      !open_verified_provider(provider, &provider_fd)) goto cleanup;
  struct passwd *owner = getpwuid(getuid());
  if (owner == NULL || owner->pw_dir == NULL) goto cleanup;
  credential_length = strlen("ANTHROPIC_API_KEY=") + password_length;
  credential_capacity = credential_length + 1;
  credential = malloc(credential_capacity);
  home = malloc(strlen("HOME=") + strlen(owner->pw_dir) + 1);
  if (credential == NULL || home == NULL) goto cleanup;
  memcpy(credential, "ANTHROPIC_API_KEY=", strlen("ANTHROPIC_API_KEY="));
  memcpy(credential + strlen("ANTHROPIC_API_KEY="), password_data, password_length);
  credential[credential_length] = '\0';
  snprintf(home, strlen("HOME=") + strlen(owner->pw_dir) + 1, "HOME=%s", owner->pw_dir);
  static const char *const setting_names[] = {
    "ANTHROPIC_MODEL",
    "ANTHROPIC_MAX_TOKENS",
    "ANTHROPIC_INPUT_COST_PER_MTOK",
    "ANTHROPIC_OUTPUT_COST_PER_MTOK",
    "DOME_DISABLE_PROMPT_CACHE",
  };
  char setting_entries[5][4096];
  char *child_env[10];
  size_t child_env_count = 0;
  child_env[child_env_count++] = credential;
  child_env[child_env_count++] = home;
  child_env[child_env_count++] = "PATH=/usr/bin:/bin";
  child_env[child_env_count++] = "TMPDIR=/tmp";
  for (size_t index = 0; index < 5; index++) {
    int included = allowlisted_env(setting_names[index], setting_entries[index], sizeof(setting_entries[index]));
    if (included < 0) goto cleanup;
    if (included > 0) child_env[child_env_count++] = setting_entries[index];
  }
  child_env[child_env_count] = NULL;
  explicit_bzero(password_data, password_length);
  SecKeychainItemFreeContent(NULL, password_data);
  password_data = NULL;
  CFRelease(keychain);
  char provider_fd_path[64];
  if (snprintf(provider_fd_path, sizeof(provider_fd_path), "/dev/fd/%d", provider_fd) >= (int)sizeof(provider_fd_path))
    goto cleanup_after_release;
  char *const child_argv[] = { bun, provider_fd_path, NULL };
  if (chdir(vault) != 0) goto cleanup_after_release;
  exec_reproved_named_inode(bun, bun_fd, &bun_identity, child_argv, child_env);
cleanup_after_release:
  if (bun_fd >= 0) close(bun_fd);
  if (provider_fd >= 0) close(provider_fd);
  explicit_bzero(credential, credential_capacity);
  free(credential);
  free(home);
  return result;

cleanup:
  if (bun_fd >= 0) close(bun_fd);
  if (provider_fd >= 0) close(provider_fd);
  if (password_data != NULL) {
    explicit_bzero(password_data, password_length);
    SecKeychainItemFreeContent(NULL, password_data);
  }
  if (credential != NULL) {
    explicit_bzero(credential, credential_capacity);
    free(credential);
  }
  free(home);
  return result;
}

int main(int argc, char **argv) {
  if (argc != 3 || (strcmp(argv[1], "replace") != 0 && strcmp(argv[1], "inspect") != 0 &&
      strcmp(argv[1], "check") != 0 && strcmp(argv[1], "remove") != 0 &&
      strcmp(argv[1], "run-model-provider") != 0)) {
    return fail("Dome Home credential helper received invalid arguments", 2);
  }
  char vault[PATH_MAX];
  if (realpath(argv[2], vault) == NULL || strcmp(vault, argv[2]) != 0 || !stable_direct_owned(vault, S_IFDIR)) {
    return fail("Dome Home vault path is not canonical and owner-controlled", 4);
  }
  char dome[PATH_MAX];
  char state[PATH_MAX];
  if (snprintf(dome, sizeof(dome), "%s/.dome", vault) >= (int)sizeof(dome) ||
      !stable_direct_owned(dome, S_IFDIR) ||
      snprintf(state, sizeof(state), "%s/state", dome) >= (int)sizeof(state) ||
      !stable_direct_owned(state, S_IFDIR)) {
    return fail("Dome Home vault state is not owner-controlled", 4);
  }
  char vault_id[ID_CAPACITY];
  if (!read_vault_id(vault, vault_id)) return fail("Dome Home vault identity is invalid", 4);
  char vault_hash[65];
  sha256_hex(vault, strlen(vault), vault_hash);
  char account[ACCOUNT_CAPACITY];
  if (snprintf(account, sizeof(account), "%s:%s:%s", vault_id, SLOT, vault_hash) >= (int)sizeof(account)) {
    return fail("Dome Home credential account is invalid", 4);
  }
  if (strcmp(argv[1], "run-model-provider") == 0) {
    OSStatus status = SecKeychainSetUserInteractionAllowed(false);
    if (status != errSecSuccess) return fail("Dome Home could not disable Keychain interaction", 4);
  } else if (strcmp(argv[1], "check") == 0) {
    OSStatus status = SecKeychainSetUserInteractionAllowed(false);
    if (status != errSecSuccess) return fail("Dome Home could not disable Keychain interaction", 4);
  }
  SecKeychainRef keychain = NULL;
  if (!open_bound_keychain(&keychain)) {
    if (keychain != NULL) CFRelease(keychain);
    return fail("Dome Home could not bind the exact user default Keychain", 4);
  }

  if (strcmp(argv[1], "run-model-provider") == 0) {
    int code = model_provider_exec(vault, keychain, account);
    if (code == 44) return 44;
    if (code == 3) return fail("Dome Home model credential access was denied", 3);
    return fail("Dome Home model provider could not start", code);
  }

  SecKeychainItemRef item = NULL;
  if (strcmp(argv[1], "inspect") == 0 || strcmp(argv[1], "remove") == 0) {
    OSStatus status = find_item(keychain, account, NULL, NULL, &item);
    if (status == errSecItemNotFound) { CFRelease(keychain); return 44; }
    if (status == errSecSuccess && strcmp(argv[1], "remove") == 0) status = SecKeychainItemDelete(item);
    if (item != NULL) CFRelease(item);
    CFRelease(keychain);
    int code = credential_status_code(status);
    if (code == 5) return fail("Dome Home Keychain is locked or unavailable", 5);
    if (code == 3) return fail("Dome Home credential access was denied or cancelled", 3);
    return code == 0 ? 0 : fail("Dome Home credential operation failed", code);
  }

  if (strcmp(argv[1], "check") == 0) {
    UInt32 password_length = 0;
    void *password_data = NULL;
    OSStatus status = find_item(keychain, account, &password_length, &password_data, &item);
    if (status == errSecSuccess && (password_data == NULL || password_length == 0 ||
        password_length > 16 * 1024 || memchr(password_data, '\0', password_length) != NULL)) {
      status = errSecDecode;
    }
    if (password_data != NULL) {
      explicit_bzero(password_data, password_length);
      SecKeychainItemFreeContent(NULL, password_data);
    }
    if (item != NULL) CFRelease(item);
    CFRelease(keychain);
    int code = credential_status_code(status);
    if (code == 5) return fail("Dome Home Keychain is locked or unavailable", 5);
    if (code == 3) return fail("Dome Home credential access was denied or cancelled", 3);
    return code == 0 ? 0 : code == 44 ? 44 : fail("Dome Home credential check failed", code);
  }

  char secret[SECRET_CAPACITY];
  memset(secret, 0, sizeof(secret));
  if (readpassphrase("Dome Home Anthropic API key: ", secret, sizeof(secret), RPP_REQUIRE_TTY) == NULL) {
    explicit_bzero(secret, sizeof(secret));
    CFRelease(keychain);
    return fail(errno == EINTR ? "Dome Home credential entry was cancelled" :
      "Dome Home credential entry requires an interactive terminal", 3);
  }
  size_t secret_length = strnlen(secret, sizeof(secret));
  if (secret_length == 0 || secret_length > 16 * 1024) {
    explicit_bzero(secret, sizeof(secret));
    CFRelease(keychain);
    return fail("Dome Home model credential is empty or exceeds 16 KiB", 3);
  }
  OSStatus status = find_item(keychain, account, NULL, NULL, &item);
  if (status == errSecSuccess && item != NULL) {
    status = SecKeychainItemModifyAttributesAndData(item, NULL, (UInt32)secret_length, secret);
  } else if (status == errSecItemNotFound) {
    status = SecKeychainAddGenericPassword(
      keychain,
      (UInt32)strlen(SERVICE), SERVICE,
      (UInt32)strlen(account), account,
      (UInt32)secret_length, secret,
      &item
    );
  }
  explicit_bzero(secret, sizeof(secret));
  if (item != NULL) CFRelease(item);
  CFRelease(keychain);
  int code = credential_status_code(status);
  if (code == 5) return fail("Dome Home Keychain is locked or unavailable", 5);
  if (code == 3) return fail("Dome Home credential access was denied or cancelled", 3);
  return code == 0 ? 0 : fail("Dome Home could not store the model credential", code);
}
