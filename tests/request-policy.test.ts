import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePublicOrigin,requestAccessError,proxyTokenMatches} from '../server/request-policy';
const publicOrigin = 'https://prototype.ai-native-lab.com';
test('公网入口必须使用 HTTPS origin，拒绝夹带路径或凭据',()=>{
 assert.equal(normalizePublicOrigin(), '');
 assert.equal(normalizePublicOrigin(publicOrigin+'/'),publicOrigin);
 for(const value of ['http://example.com','https://a:b@example.com','https://example.com/path','https://example.com/?a=1','https://example.com/#a'])
  assert.throws(()=>normalizePublicOrigin(value));
});
test('服务端必须验证入口令牌，不能通过直连或伪造 Host 绕过入口认证',()=>{
 assert.equal(proxyTokenMatches('',undefined),true);
 assert.equal(proxyTokenMatches('test-gateway-token',undefined),false);
 assert.equal(proxyTokenMatches('test-gateway-token','bad-token'),false);
 assert.equal(proxyTokenMatches('test-gateway-token',['test-gateway-token']),false);
 assert.equal(proxyTokenMatches('test-gateway-token','test-gateway-token'),true);
});
test('本地访问保持兼容，公网只能使用配置的精确域名',()=>{
 assert.equal(requestAccessError('POST','127.0.0.1:4318','http://127.0.0.1:4318',''),undefined);
 assert.ok(requestAccessError('GET','prototype.ai-native-lab.com',undefined,''));
 assert.equal(requestAccessError('GET','prototype.ai-native-lab.com',undefined,publicOrigin),undefined);
 assert.ok(requestAccessError('GET','prototype.ai-native-lab.com.evil.test',undefined,publicOrigin));
 assert.ok(requestAccessError('POST','prototype.ai-native-lab.com','https://evil.test',publicOrigin));
 assert.ok(requestAccessError('POST','prototype.ai-native-lab.com','null',publicOrigin));
 assert.ok(requestAccessError('POST','prototype.ai-native-lab.com',undefined,publicOrigin,'cross-site'));
 assert.equal(requestAccessError('POST','prototype.ai-native-lab.com',publicOrigin,publicOrigin,'same-origin'),undefined);
 assert.equal(requestAccessError('POST','prototype.ai-native-lab.com',undefined,publicOrigin),undefined);
});
