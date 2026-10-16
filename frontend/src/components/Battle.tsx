import React, { useEffect, useState, useRef } from 'react';
import { Card, Row, Col, Button, Tabs, List, Tag, Statistic, message, Avatar, TabsProps, Modal, Progress } from 'antd';
import { TrophyOutlined, FireOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { petAPI, battleAPI, authAPI } from '../utils/api';
import { getPetThumbUrl } from '../utils/petImage';
import { usePetStore, useAuthStore } from '../store/authStore';
import dayjs from 'dayjs';
import CelebrationAnimation from './CelebrationAnimation';

const useMobile = () => {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
};

const Battle: React.FC = () => {
  const { user, currentClass } = useAuthStore();
  const { pet } = usePetStore();
  const isMobile = useMobile();
  const [opponents, setOpponents] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [battleResult, setBattleResult] = useState<any>(null);
  const [battleModalVisible, setBattleModalVisible] = useState(false);
  
  // 战斗动画状态
  const [showBattleAnimation, setShowBattleAnimation] = useState(false);
  const [currentRound, setCurrentRound] = useState(0);
  const [battleAnimationComplete, setBattleAnimationComplete] = useState(false);
  
  // 庆祝动画
  const animationCancelledRef = useRef(false);
  const [showCelebration, setShowCelebration] = useState(false);
  const [celebrationData, setCelebrationData] = useState({
    expReward: 0,
    goldReward: 0,
    leveledUp: false,
    newLevel: 0
  });

  useEffect(() => {
    loadOpponents();
    if (user) {
      loadHistory();
    }
  }, [user, currentClass]);

  const loadOpponents = async () => {
    try {
      const classId = currentClass?.id || user?.class_id;
      const response = await petAPI.getAllPets(classId ? { class_id: classId } : undefined);
      const others = (response.data.pets || []).filter((p: any) => p.user_id !== user?.id);
      setOpponents(others);
    } catch (error) {
      console.error('加载对手失败:', error);
    }
  };

  const loadHistory = async () => {
    if (!user) return;
    try {
      const response = await battleAPI.getBattleHistory();
      setHistory(response.data.battles || []);
    } catch (error) {
      console.error('加载战斗记录失败:', error);
    }
  };

  const handleBattle = async (opponentId: number) => {
    if (!user) {
      message.warning('你需要先登录才能进行战斗！');
      return;
    }
    if (!pet) {
      message.warning('你需要先拥有一只宠物才能战斗！');
      return;
    }

    setLoading(true);
    try {
      const res = await battleAPI.startBattle({ opponent_pet_id: opponentId });
      const { winner, rewardExp, rewardGold, battleLog, myWinChance } = res.data;

      setBattleResult({
        winner,
        rewardExp,
        rewardGold,
        battleLog,
        myWinChance
      });
      
      // 显示战斗动画
      animationCancelledRef.current = false;
      setShowBattleAnimation(true);
      setCurrentRound(0);
      setBattleAnimationComplete(false);
      setBattleModalVisible(true);

      // 逐回合播放动画
      if (battleLog && battleLog.rounds) {
        for (let i = 0; i < battleLog.rounds.length; i++) {
          await new Promise(resolve => setTimeout(resolve, 1500));
          if (animationCancelledRef.current) return;
          setCurrentRound(i + 1);
        }
      }

      // 动画完成后显示完整结果
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (animationCancelledRef.current) return;
      setBattleAnimationComplete(true);
      
      if (winner === '我') {
        message.success(`🎉 战斗胜利！获得了 ${rewardExp} 经验 和 ${rewardGold} 金币`);
        
        // 显示庆祝动画
        setCelebrationData({
          expReward: rewardExp || 0,
          goldReward: rewardGold || 0,
          leveledUp: !!res.data.levelUp,
          newLevel: res.data.levelUp?.newLevel || 0
        });
        setShowCelebration(true);
        
        setTimeout(() => {
          setShowCelebration(false);
        }, 5000);
      } else {
        message.error('💥 战斗失败！再接再厉！');
      }

      // 更新宠物信息和用户金币
      const { setPet } = usePetStore.getState();
      const { setUser } = useAuthStore.getState();
      try {
        const petRes = await petAPI.getMyPet();
        setPet(petRes.data.pet);
        const userRes = await authAPI.getMe();
        setUser(userRes.data.user);
      } catch (e) {
        console.error('更新宠物信息失败:', e);
      }

      loadHistory();
    } catch (error: any) {
      message.error(error.response?.data?.error || '战斗发起失败');
    } finally {
      setLoading(false);
    }
  };

  const tabItems: TabsProps['items'] = [
    {
      key: 'opponents',
      label: '寻找对手',
      children: (
        <Row gutter={[16, 16]}>
          {opponents.map((opponent: any) => (
            <Col xs={24} sm={12} md={8} lg={6} key={opponent.id}>
              <Card 
                hoverable
                style={{ borderRadius: '12px', overflow: 'hidden' }}
                styles={{ body: { padding: '16px' } }}
                cover={
                  <div style={{ height: 160, display: 'flex', justifyContent: 'center', alignItems: 'center', background: '#f5f7fa', padding: '20px' }}>
                    {(() => {
                      const imageUrl = getPetThumbUrl(opponent);
                      if (!imageUrl) return <span style={{ fontSize: '64px' }}>🐾</span>;
                      if (imageUrl.startsWith('http') || imageUrl.startsWith('/')) {
                        return <img alt={opponent.name} src={imageUrl} loading="lazy" style={{ maxHeight: '100%', maxWidth: '100%', objectFit: 'contain' }} />;
                      }
                      return <span style={{ fontSize: '64px' }}>{imageUrl}</span>;
                    })()}
                  </div>
                }
                actions={[
                  <Button 
                    type="primary" 
                    danger 
                    icon={<FireOutlined />} 
                    onClick={() => handleBattle(opponent.id)}
                    loading={loading}
                    block
                    style={{ borderRadius: 0 }}
                  >
                    发起挑战
                  </Button>
                ]}
              >
                <Card.Meta 
                  title={opponent.name}
                  description={`${opponent.owner_name}的宠物`}
                />
                <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between' }}>
                  <Statistic title="等级" value={opponent.level} valueStyle={{ fontSize: 16 }} />
                  <Statistic title="战斗力" value={opponent.attack + opponent.defense + opponent.speed} valueStyle={{ fontSize: 16, color: '#cf1322' }} prefix={<ThunderboltOutlined />} />
                </div>
              </Card>
            </Col>
          ))}
          {opponents.length === 0 && (
            <div style={{ width: '100%', textAlign: 'center', padding: '40px', color: '#999' }}>
              目前没有可挑战的对手
            </div>
          )}
        </Row>
      )
    },
    {
      key: 'history',
      label: '战斗记录',
      children: (
        !user ? (
          <Card style={{ borderRadius: '12px', textAlign: 'center', padding: '40px' }}>
            <h3 style={{ color: '#999', marginBottom: 20 }}>未登录无法查看战斗记录</h3>
            <Button type="primary" onClick={() => window.location.href = '/login'}>前往登录</Button>
          </Card>
        ) : (
          <Card style={{ borderRadius: '12px' }}>
            <List
              itemLayout="horizontal"
              dataSource={history}
              renderItem={(item: any) => {
                const isWinner = item.winner_id === pet?.id;
                const opponentName = item.pet1_id === pet?.id ? item.pet2_name : item.pet1_name;
                
                return (
                  <List.Item>
                    <List.Item.Meta
                      avatar={
                        <Avatar 
                          size={48} 
                          style={{ backgroundColor: isWinner ? '#f6ffed' : '#fff1f0', color: isWinner ? '#52c41a' : '#f5222d', fontSize: 24 }}
                        >
                          {isWinner ? '🏆' : '💀'}
                        </Avatar>
                      }
                      title={
                        <span style={{ fontSize: 16 }}>
                          挑战 <span style={{ fontWeight: 'bold' }}>{opponentName}</span>
                          <Tag color={isWinner ? 'success' : 'error'} style={{ marginLeft: 12 }}>
                            {isWinner ? '胜利' : '失败'}
                          </Tag>
                        </span>
                      }
                      description={`战斗时间: ${dayjs(item.battle_date).format('YYYY-MM-DD HH:mm:ss')}`}
                    />
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ color: '#faad14', fontWeight: 'bold' }}>+{item.reward_exp} 经验</div>
                      {isWinner && item.reward_gold > 0 && (
                        <div style={{ color: '#d4b106' }}>+{item.reward_gold} 金币</div>
                      )}
                    </div>
                  </List.Item>
                );
              }}
            />
          </Card>
        )
      )
    }
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 20, gap: 12 }}>
        <TrophyOutlined style={{ fontSize: 24, color: '#faad14' }} />
        <h2 style={{ margin: 0 }}>竞技场</h2>
      </div>

      <Tabs defaultActiveKey="opponents" items={tabItems} />

      <Modal
        title={
          <div style={{ textAlign: 'center' }}>
            {battleAnimationComplete ? (
              battleResult?.winner === '我' ? '🏆 战斗胜利！' : '💀 战斗失败'
            ) : (
              `⚔️ 战斗中... 第${currentRound}回合`
            )}
          </div>
        }
        open={battleModalVisible}
        onCancel={() => {
          animationCancelledRef.current = true;
          setBattleModalVisible(false);
          setShowBattleAnimation(false);
          setCurrentRound(0);
          setBattleAnimationComplete(false);
        }}
        footer={[
          <Button key="close" type="primary" onClick={() => {
            animationCancelledRef.current = true;
            setBattleModalVisible(false);
            setShowBattleAnimation(false);
            setCurrentRound(0);
            setBattleAnimationComplete(false);
          }}>
            确定
          </Button>
        ]}
        width={isMobile ? '95vw' : 700}
        maskClosable={false}
      >
        {battleResult && (
          <div>
            {/* 战斗中动画 */}
            {showBattleAnimation && !battleAnimationComplete && battleResult.battleLog && battleResult.battleLog.rounds && battleResult.battleLog.rounds.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <Progress 
                  percent={Math.round((currentRound / battleResult.battleLog.rounds.length) * 100)} 
                  status="active"
                  strokeColor={{ from: '#108ee9', to: '#87d068' }}
                />
                
                <div style={{ 
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  padding: 24,
                  borderRadius: 12,
                  color: '#fff',
                  marginBottom: 16,
                  animation: 'battle-flash 0.5s ease-in-out'
                }}>
                  {(() => {
                    const round = battleResult.battleLog.rounds[currentRound - 1];
                    if (!round) return null;
                    
                    return (
                      <div>
                        <div style={{ fontSize: 20, fontWeight: 'bold', marginBottom: 16 }}>
                          第 {round.round} 回合
                        </div>
                        <Row gutter={16}>
                          <Col xs={24} md={12}>
                            <div style={{
                              background: 'rgba(255,255,255,0.2)',
                              padding: 12,
                              borderRadius: 8,
                              animation: 'attack-left 0.6s ease-out'
                            }}>
                              <div style={{ fontSize: 14, marginBottom: 8 }}>🐲 你的宠物</div>
                              <div style={{ fontSize: 24, fontWeight: 'bold' }}>
                                造成 {round.myPet.damage} 伤害
                              </div>
                              {round.myPet.critical && (
                                <Tag color="red" style={{ marginTop: 8, fontSize: 12 }}>
                                  🔥 暴击！
                                </Tag>
                              )}
                            </div>
                          </Col>
                          <Col xs={24} md={12}>
                            <div style={{
                              background: 'rgba(255,255,255,0.2)',
                              padding: 12,
                              borderRadius: 8,
                              animation: 'attack-right 0.6s ease-out'
                            }}>
                              <div style={{ fontSize: 14, marginBottom: 8 }}>👹 对手宠物</div>
                              <div style={{ fontSize: 24, fontWeight: 'bold' }}>
                                造成 {round.opponent.damage} 伤害
                              </div>
                              {round.opponent.critical && (
                                <Tag color="red" style={{ marginTop: 8, fontSize: 12 }}>
                                  🔥 暴击！
                                </Tag>
                              )}
                            </div>
                          </Col>
                        </Row>
                      </div>
                    );
                  })()}
                </div>
                
                <div style={{ textAlign: 'center', color: '#999' }}>
                  正在播放战斗动画...
                </div>
              </div>
            )}
            
            {/* 完整结果 */}
            {battleAnimationComplete && (
              <div style={{ animation: 'fade-in 0.5s ease-out' }}>
            <div style={{ textAlign: 'center', marginBottom: 24 }}>
              <div style={{ fontSize: 64, marginBottom: 16 }}>
                {battleResult.winner === '我' ? '🏆' : '💀'}
              </div>
              <h2 style={{ fontSize: 28, marginBottom: 8 }}>
                {battleResult.winner === '我' ? '恭喜获胜！' : '对战失败'}
              </h2>
              <div style={{ color: '#999' }}>
                胜率预测: {battleResult.myWinChance}%
              </div>
            </div>

            {battleResult.battleLog && battleResult.battleLog.rounds && (
              <div style={{ background: '#f5f5f5', padding: 16, borderRadius: 8, marginBottom: 16 }}>
                <h4 style={{ marginBottom: 12 }}>战斗回放</h4>
                {battleResult.battleLog.rounds.map((round: any, idx: number) => (
                  <div key={idx} style={{ marginBottom: 12, paddingBottom: 12, borderBottom: idx < battleResult.battleLog.rounds.length - 1 ? '1px solid #ddd' : 'none' }}>
                    <div style={{ fontWeight: 'bold', color: '#667eea', marginBottom: 4 }}>第 {round.round} 回合</div>
                    <div style={{ fontSize: 13 }}>
                      <div>你的宠物: -{round.myPet.damage} HP {round.myPet.critical && '🔥暴击!'}</div>
                      <div>对手宠物: -{round.opponent.damage} HP</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'center', gap: 32, marginBottom: 16 }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, color: '#52c41a', fontWeight: 'bold' }}>+{battleResult.rewardExp}</div>
                <div style={{ color: '#999' }}>经验</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, color: '#eb2f96', fontWeight: 'bold' }}>{battleResult.moodChange > 0 ? '+' : ''}{battleResult.moodChange}</div>
                <div style={{ color: '#999' }}>心情</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, color: '#722ed1', fontWeight: 'bold' }}>-20</div>
                <div style={{ color: '#999' }}>体力</div>
              </div>
            </div>

            {battleResult.levelUp && (
              <div style={{ textAlign: 'center', color: '#faad14', fontSize: 18, fontWeight: 'bold' }}>
                🎉 升级了！当前等级: Lv.{battleResult.levelUp.newLevel}
              </div>
            )}
              </div>
            )}
          </div>
        )}
        
        {/* CSS动画 */}
        <style>{`
          @keyframes battle-flash {
            0% { opacity: 0; transform: scale(0.9); }
            50% { opacity: 1; transform: scale(1.05); }
            100% { opacity: 1; transform: scale(1); }
          }
          
          @keyframes attack-left {
            0% { transform: translateX(-50px); opacity: 0; }
            100% { transform: translateX(0); opacity: 1; }
          }
          
          @keyframes attack-right {
            0% { transform: translateX(50px); opacity: 0; }
            100% { transform: translateX(0); opacity: 1; }
          }
          
          @keyframes fade-in {
            0% { opacity: 0; }
            100% { opacity: 1; }
          }
          
          @keyframes victory-bounce {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.2); }
          }
        `}</style>
      </Modal>
      
      {/* 庆祝动画 */}
      <CelebrationAnimation
        show={showCelebration}
        expReward={celebrationData.expReward}
        goldReward={celebrationData.goldReward}
        leveledUp={celebrationData.leveledUp}
        newLevel={celebrationData.newLevel}
      />
    </div>
  );
};

export default Battle;