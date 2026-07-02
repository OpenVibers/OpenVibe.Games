/* ovjs_win_builtins.c — 128-bit integer division builtins for the Windows
 * clang-cl QuickJS build.
 *
 * clang lowers __int128 division in QuickJS's BigInt code to calls into the
 * compiler-rt builtins __udivti3/__umodti3/__divti3/__modti3. Those live in
 * compiler-rt's builtins library, which isn't linked when packing clang-cl
 * objects into an MSVC-linked DLL, producing LNK2019 __udivti3. We provide the
 * routines here (compiled by clang-cl, which supports __int128) using binary
 * long division — the operators themselves must NOT use `/` or `%` on __int128,
 * as that would recurse back into these builtins.
 *
 * This file is only meaningful under clang on Windows; elsewhere it is empty. */
#if defined(_WIN32) && defined(__clang__)

typedef unsigned __int128 ovjs_u128;
typedef signed   __int128 ovjs_s128;

/* Unsigned 128-bit divmod via shift-subtract long division. */
static ovjs_u128 ovjs_udivmod128(ovjs_u128 num, ovjs_u128 den, ovjs_u128 *rem_out)
{
    if (den == 0) { /* undefined; match hardware trap behavior loosely */
        if (rem_out) *rem_out = 0;
        return ~(ovjs_u128)0;
    }
    ovjs_u128 quot = 0;
    ovjs_u128 rem = 0;
    for (int i = 127; i >= 0; --i) {
        rem <<= 1;
        rem |= (num >> i) & 1u;
        if (rem >= den) {
            rem -= den;
            quot |= ((ovjs_u128)1) << i;
        }
    }
    if (rem_out) *rem_out = rem;
    return quot;
}

ovjs_u128 __udivti3(ovjs_u128 a, ovjs_u128 b)
{
    return ovjs_udivmod128(a, b, 0);
}

ovjs_u128 __umodti3(ovjs_u128 a, ovjs_u128 b)
{
    ovjs_u128 rem;
    ovjs_udivmod128(a, b, &rem);
    return rem;
}

ovjs_s128 __divti3(ovjs_s128 a, ovjs_s128 b)
{
    int neg = 0;
    ovjs_u128 ua, ub, uq;
    if (a < 0) { ua = (ovjs_u128)(-a); neg ^= 1; } else { ua = (ovjs_u128)a; }
    if (b < 0) { ub = (ovjs_u128)(-b); neg ^= 1; } else { ub = (ovjs_u128)b; }
    uq = ovjs_udivmod128(ua, ub, 0);
    return neg ? -(ovjs_s128)uq : (ovjs_s128)uq;
}

ovjs_s128 __modti3(ovjs_s128 a, ovjs_s128 b)
{
    int neg = (a < 0);
    ovjs_u128 ua, ub, ur;
    ua = (a < 0) ? (ovjs_u128)(-a) : (ovjs_u128)a;
    ub = (b < 0) ? (ovjs_u128)(-b) : (ovjs_u128)b;
    ovjs_udivmod128(ua, ub, &ur);
    return neg ? -(ovjs_s128)ur : (ovjs_s128)ur;
}

#else
/* Keep the translation unit non-empty for non-clang/non-Windows toolchains. */
typedef int ovjs_win_builtins_translation_unit_not_empty;
#endif
