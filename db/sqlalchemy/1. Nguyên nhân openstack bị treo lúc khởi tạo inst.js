1. Nguyên nhân openstack bị treo lúc khởi tạo instance trùng tên 
a.	Do trong openstack sử dụng hàm  _validate_unique_server_name(context, name):
	https://github.com/openstack/nova/blob/31694d7e2702d732a97a3fa82a7e3a3ad264f5bb/nova/db/sqlalchemy/api.py#L1684

	Nội dung hàm như sau:
	def _validate_unique_server_name(context, name):
    if not CONF.osapi_compute_unique_server_name_scope:
        return

    lowername = name.lower()
    base_query = model_query(context, models.Instance, read_deleted='no').\
            filter(func.lower(models.Instance.hostname) == lowername)

    if CONF.osapi_compute_unique_server_name_scope == 'project':
        instance_with_same_name = base_query.\
                        filter_by(project_id=context.project_id).\
                        count()

    elif CONF.osapi_compute_unique_server_name_scope == 'global':
        instance_with_same_name = base_query.count()

    else:
        return

    if instance_with_same_name > 0:
        raise exception.InstanceExists(name=lowername)
    # Đếm số instance đã sử dụng tên đó và nếu lớn hơn 0 thì raise một exception InstanceExists.

b. Hàm này được sử dụng trong bước instance_create(context, values): và _instance_update(context, instance_uuid, values, expected, original=None):

https://github.com/openstack/nova/blob/31694d7e2702d732a97a3fa82a7e3a3ad264f5bb/nova/db/sqlalchemy/api.py#L1733


https://github.com/openstack/nova/blob/31694d7e2702d732a97a3fa82a7e3a3ad264f5bb/nova/db/sqlalchemy/api.py#L2773


c. Hàm instance_create(context, values) được sử dụng trong bước  schedule_and_build_instances(): tại nova_conductor và nova_scheduler

https://github.com/openstack/nova/blob/31694d7e2702d732a97a3fa82a7e3a3ad264f5bb/nova/conductor/manager.py#L1156
+=> Hàm này gây lỗi exception trong luồng khởi tạo instance gây ra 2 vấn đề:
	Horizon tắc ở bước SCHEDULING
	Instance đã được ghi thông tin vào nova_placement_api trong database: nova_api.allocations

2. Giải pháp:
	Trước khi đưa vào chạy instance thêm một exception ngay tại nova-conductor:


################################################ lamtv10 start edit in here ##########################################
    def check_instance_display_name_exist(self, instance_uuids):
        db_engine_name = db.create_engine(CONF.api_database.connection)
        db_connection_name = db_engine_name.connect()
        db_metadata_name = db.MetaData()
        build_requests=db.Table('build_requests',db_metadata_name, autoload=True, autoload_with=db_engine_name)
        instances_display_name=db_connection_name.execute(db.select([build_requests.columns.instance]).where(build_requests.columns.instance_uuid.in_(instance_uuids) )).fetchall()

        name_instance=[]
        for i in range(0,len(instance_uuids)):
            #print(json.loads(instances_display_name[i][0])['nova_object.data']['display_name'])
            name_instance.append(jsonutils.loads(instances_display_name[i][0])['nova_object.data']['display_name'])

        db_engine = db.create_engine(CONF.database.connection)
        db_connection = db_engine.connect()
        db_metadata = db.MetaData()
        nova_instances=db.Table('instances',db_metadata, autoload=True, autoload_with=db_engine)

        instance_info=db_connection.execute(db.select([nova_instances.columns.vm_state]).where(db.and_(nova_instances.columns.display_name.in_(name_instance) , nova_instances.columns.vm_state.notin_(["deleted","error"]) ))).fetchall()

        if len(instance_info) > 0:
            raise exception.InstanceExists("Instance's name already exist!")

    def schedule_and_build_instances(self, context, build_requests,
                                     request_specs, image,
                                     admin_password, injected_files,
                                     requested_networks, block_device_mapping,
                                     tags=None):
        # Add all the UUIDs for the instances
        instance_uuids = [spec.instance_uuid for spec in request_specs]
        try:
            if  len(instance_uuids) > 0 :
                self.check_instance_display_name_exist(instance_uuids)
            host_lists = self._schedule_instances(context, request_specs[0],
                    instance_uuids, return_alternates=True)
        except Exception as exc:
            LOG.exception('Failed to schedule instances')
            self._bury_in_cell0(context, request_specs[0], exc,
                                build_requests=build_requests,
                                block_device_mapping=block_device_mapping)
            return

###########################################################################################################################################


	Sửa trong db/sqlalchemy/api.py bổ xung trường hợp instance name đã tồn tại nhưng ở trạng thái Error thì vẫn phải cho tạo instance mới.
########################################## lamtv10 start edit in here #######################################

def _validate_unique_server_name(context, name):
    if not CONF.osapi_compute_unique_server_name_scope:
        return

    lowername = name.lower()
    base_query = model_query(context, models.Instance, read_deleted='no').\
            filter(func.lower(models.Instance.hostname) == lowername,models.Instance.vm_state!='error')

    if CONF.osapi_compute_unique_server_name_scope == 'project':
        instance_with_same_name = base_query.\
                        filter_by(project_id=context.project_id).\
                        count()

    elif CONF.osapi_compute_unique_server_name_scope == 'global':
        instance_with_same_name = base_query.count()

    else:
        return

    if instance_with_same_name > 0:
        raise exception.InstanceExists(name=lowername)


################################################# lamtv10 end edit in here ####################################