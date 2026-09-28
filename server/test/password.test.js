import './_setup.js';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkPasswordStrength,
  hashPassword,
  verifyPassword,
} from '../src/lib/password.js';

test('password 哈希后能验证通过', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.ok(verifyPassword('correct horse battery staple', hash));
});

test('password 错误密码验证失败', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('wrong password', hash), false);
  assert.equal(verifyPassword('Correct horse battery staple', hash), false);
  assert.equal(verifyPassword('', hash), false);
});

test('password 同一密码两次哈希结果不同（盐是随机的）', () => {
  const a = hashPassword('same-password-here');
  const b = hashPassword('same-password-here');
  assert.notEqual(a, b);
  assert.ok(verifyPassword('same-password-here', a));
  assert.ok(verifyPassword('same-password-here', b));
});

test('password 哈希串格式与参数被记录', () => {
  const hash = hashPassword('whatever-12345');
  const parts = hash.split('$');
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'scrypt');
  assert.equal(parts[1], '32768');
  assert.equal(parts[2], '8');
  assert.equal(parts[3], '1');
});

test('password 支持中文和超长密码', () => {
  const pw = '这是一个很长的中文密码'.repeat(20);
  const hash = hashPassword(pw);
  assert.ok(verifyPassword(pw, hash));
  assert.equal(verifyPassword(pw.slice(0, -1), hash), false);
});

test('password 面对畸形存储串不抛异常，只返回 false', () => {
  for (const bad of [
    '',
    'not-a-hash',
    'scrypt$1$2$3$4',            // 段数不对
    'bcrypt$32768$8$1$AAAA$BBBB', // 算法不对
    'scrypt$abc$8$1$AAAA$BBBB',   // 参数不是数字
    'scrypt$32768$8$1$$',         // 盐和 key 为空
    'scrypt$32768$8$1$!!!$!!!',   // base64 非法
  ]) {
    assert.equal(verifyPassword('anything', bad), false, `应拒绝：${bad}`);
  }
});

test('password 非字符串输入不抛异常', () => {
  const hash = hashPassword('some-password');
  assert.equal(verifyPassword(null, hash), false);
  assert.equal(verifyPassword(undefined, hash), false);
  assert.equal(verifyPassword(12345, hash), false);
  assert.equal(verifyPassword('x', null), false);
});

test('password 空密码不允许哈希', () => {
  assert.throws(() => hashPassword(''));
  assert.throws(() => hashPassword(null));
});

test('checkPasswordStrength 拒绝过短密码', () => {
  assert.ok(checkPasswordStrength('short'));
  assert.ok(checkPasswordStrength('1234567'));
  assert.equal(checkPasswordStrength('12345678'), null);
});

test('checkPasswordStrength 拒绝单一重复字符', () => {
  assert.ok(checkPasswordStrength('aaaaaaaa'));
  assert.equal(checkPasswordStrength('aaaaaaaab'), null);
});
